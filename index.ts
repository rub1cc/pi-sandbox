/**
 * Codex-style permissions and OS-level sandboxing for Pi.
 *
 * This extension is the sole owner of bash execution. It combines:
 * - OS-enforced command sandboxing via @anthropic-ai/sandbox-runtime
 * - manual or model-based review for sandbox escalation requests
 * - path gates for Pi's built-in file tools and apply_patch
 * - a /permissions selector for Ask, Approve for me, and Full access
 *
 * Config files are merged with project settings taking precedence:
 * - ~/.pi/agent/extensions/sandbox.json
 * - <cwd>/.pi/sandbox.json
 */

import {
  SandboxManager,
} from "@anthropic-ai/sandbox-runtime";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  DynamicBorder,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
} from "@earendil-works/pi-tui";
import { codexBashRenderers } from "../renderer/renderers.ts";
import { ApprovalController } from "./approvals.ts";
import {
  configuredMode,
  loadConfig,
  runtimeConfigForCwd,
  saveDefaultMode,
  type SandboxConfig,
} from "./config.ts";
import { createSandboxedBashOperations } from "./executor.ts";
import {
  getPermissionModeInfo,
  PERMISSION_MODES,
  type PermissionMode,
} from "./modes.ts";
import {
  commandPermissionRequest,
  evaluateToolPermission,
  type FilesystemPolicyConfig,
  networkPermissionRequest,
  stabilizeToolInput,
} from "./policy.ts";

interface PermissionBashInput {
  command: string;
  timeout?: number;
  sandbox_permissions?: "use_default" | "require_escalated";
  justification?: string;
}

interface PermissionSelection {
  mode: PermissionMode;
  saveAsDefault: boolean;
}

const MANDATORY_WRITE_DENIES = [
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".gitconfig",
  ".gitmodules",
  ".ripgreprc",
  ".mcp.json",
  "./.vscode",
  "**/.vscode/**",
  "./.idea",
  "**/.idea/**",
  "./.claude/commands",
  "**/.claude/commands/**",
  "./.claude/agents",
  "**/.claude/agents/**",
  "./.git/hooks",
  "**/.git/hooks/**",
] as const;

const GIT_CONFIG_WRITE_DENIES = ["./.git/config", "**/.git/config"] as const;
const FILE_POLICY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "apply_patch",
]);

function permissionBashParameters(parameters: unknown): unknown {
  const schema = parameters as {
    properties?: Record<string, unknown>;
    [key: string]: unknown;
  };
  return {
    ...schema,
    properties: {
      ...schema.properties,
      sandbox_permissions: {
        type: "string",
        enum: ["use_default", "require_escalated"],
        description:
          "Use the sandbox by default. Set require_escalated only when the command must access blocked network destinations or files outside the sandbox.",
      },
      justification: {
        type: "string",
        description:
          "Concise reason escalated execution is necessary. Required when sandbox_permissions is require_escalated.",
      },
    },
  };
}

function safeBashInput(params: PermissionBashInput): {
  command: string;
  timeout?: number;
} {
  return { command: params.command, timeout: params.timeout };
}

function filesystemApprovalPolicy(config: SandboxConfig): FilesystemPolicyConfig {
  const credentialPaths = (config.credentials?.files ?? []).map((file) => file.path);
  const gitConfigDenies = config.filesystem.allowGitConfig
    ? []
    : GIT_CONFIG_WRITE_DENIES;
  return {
    ...config.filesystem,
    denyRead: [...config.filesystem.denyRead, ...credentialPaths],
    denyWrite: [
      ...config.filesystem.denyWrite,
      ...MANDATORY_WRITE_DENIES,
      ...gitConfigDenies,
    ],
  };
}

async function selectPermissionMode(
  ctx: ExtensionContext,
  current: PermissionMode,
): Promise<PermissionSelection | undefined> {
  const items: SelectItem[] = PERMISSION_MODES.map((mode) => ({
    value: mode.id,
    label: `${mode.label}${mode.id === current ? " (current)" : ""}`,
    description: mode.description,
  }));

  // RPC clients support built-in dialogs but not custom terminal components.
  if (ctx.mode !== "tui") {
    const options = items.map(
      (item) => `${item.label} — ${item.description ?? ""}`,
    );
    const selected = await ctx.ui.select("Update Model Permissions", options);
    if (!selected) return undefined;
    const mode = PERMISSION_MODES.find((candidate) =>
      selected.startsWith(candidate.label),
    );
    return mode ? { mode: mode.id, saveAsDefault: false } : undefined;
  }

  return ctx.ui.custom<PermissionSelection | undefined>(
    (tui, theme, _keybindings, done) => {
      const container = new Container();
      container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
      container.addChild(
        new Text(theme.fg("accent", theme.bold("Update Model Permissions"))),
      );

      const selectList = new SelectList(items, items.length, {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      });
      selectList.setSelectedIndex(
        Math.max(0, PERMISSION_MODES.findIndex((mode) => mode.id === current)),
      );
      selectList.onSelect = (item) => {
        done({ mode: item.value as PermissionMode, saveAsDefault: false });
      };
      selectList.onCancel = () => done(undefined);
      container.addChild(selectList);
      container.addChild(
        new Text(
          theme.fg(
            "dim",
            "↑↓ navigate • enter use for this session • ctrl+s use & save global default • esc cancel",
          ),
        ),
      );
      container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleMouse: (event) => container.handleMouse(event),
        handleInput: (data: string) => {
          if (matchesKey(data, Key.ctrl("s"))) {
            const selected = selectList.getSelectedItem();
            if (selected) {
              done({
                mode: selected.value as PermissionMode,
                saveAsDefault: true,
              });
            }
            return;
          }
          selectList.handleInput(data);
          tui.requestRender();
        },
      };
    },
  );
}

export default function sandboxExtension(pi: ExtensionAPI) {
  pi.registerFlag("no-sandbox", {
    description: "Start in Full access mode (no sandbox or approval prompts)",
    type: "boolean",
    default: false,
  });

  const startupCwd = process.cwd();
  const directBash = createBashToolDefinition(startupCwd);
  let config = loadConfig(startupCwd);
  const approvals = new ApprovalController(configuredMode(config));
  const approvedEscalatedCalls = new Set<string>();
  let sandboxInitialized = false;
  let sandboxInitialization: Promise<void> | undefined;
  let sandboxError: string | undefined;
  let activeContext: ExtensionContext | undefined;

  const updateStatus = (ctx: ExtensionContext) => {
    const mode = approvals.getMode();
    const info = getPermissionModeInfo(mode);
    const unavailable = info.sandboxed && !sandboxInitialized;
    const suffix = unavailable ? " (sandbox unavailable)" : "";
    const color =
      mode === "full-access" ? "warning" : unavailable ? "error" : "accent";
    ctx.ui.setStatus(
      "permissions",
      ctx.ui.theme.fg(color, `Permissions: ${info.label}${suffix}`),
    );
    ctx.ui.setStatus("sandbox", undefined);
  };

  const requestNetworkPermission = async (host: string, port?: number) => {
    const ctx = activeContext;
    if (!ctx) return false;
    const decision = await approvals.authorize(
      networkPermissionRequest(host, port),
      ctx,
    );
    return decision.allowed;
  };

  const ensureSandbox = async (ctx: ExtensionContext): Promise<void> => {
    activeContext = ctx;
    const runtimeConfig = runtimeConfigForCwd(config, ctx.cwd, [
      ...MANDATORY_WRITE_DENIES,
      ...(config.filesystem.allowGitConfig ? [] : GIT_CONFIG_WRITE_DENIES),
    ]);
    if (sandboxInitialized && SandboxManager.isSandboxingEnabled()) {
      SandboxManager.updateConfig(runtimeConfig);
      sandboxError = undefined;
      return;
    }
    if (sandboxInitialization) return sandboxInitialization;

    const platform = process.platform;
    if (platform !== "darwin" && platform !== "linux") {
      sandboxError = `Sandbox is not supported on ${platform}`;
      throw new Error(sandboxError);
    }

    sandboxInitialization = SandboxManager.initialize(
      runtimeConfig,
      ({ host, port }) => requestNetworkPermission(host, port),
      true,
    )
      .then(() => {
        sandboxInitialized = true;
        sandboxError = undefined;
      })
      .catch((error) => {
        sandboxInitialized = false;
        sandboxError = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        sandboxInitialization = undefined;
      });

    return sandboxInitialization;
  };

  const switchMode = async (
    nextMode: PermissionMode,
    ctx: ExtensionContext,
    saveAsDefault = false,
  ): Promise<boolean> => {
    const alreadyActive = nextMode === approvals.getMode();
    if (alreadyActive && !(nextMode === "full-access" && saveAsDefault)) {
      if (saveAsDefault) return true;
      ctx.ui.notify(`${getPermissionModeInfo(nextMode).label} is already active`, "info");
      return true;
    }

    if (nextMode === "full-access") {
      if (!ctx.hasUI) {
        ctx.ui.notify("Full access requires an interactive confirmation", "error");
        return false;
      }
      const confirmed = await ctx.ui.confirm(
        saveAsDefault ? "Save Full access as the default?" : "Enable Full access?",
        `Full access disables the command sandbox and approval prompts. Commands and file tools can read, modify, or delete files anywhere your user account can access, and can use the network without review.\n\n${
          saveAsDefault
            ? "Future sessions will start in Full access. Save this default only if you understand the risk."
            : "Enable only for a task and repository you trust."
        }`,
      );
      if (!confirmed) return false;
    } else {
      try {
        await ensureSandbox(ctx);
      } catch (error) {
        ctx.ui.notify(
          `Cannot enable ${getPermissionModeInfo(nextMode).label}: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
        updateStatus(ctx);
        return false;
      }
    }

    approvals.setMode(nextMode);
    approvedEscalatedCalls.clear();
    updateStatus(ctx);
    ctx.ui.notify(`Permissions updated to ${getPermissionModeInfo(nextMode).label}`, "info");
    return true;
  };

  pi.registerTool({
    ...directBash,
    ...codexBashRenderers,
    executionMode: "sequential",
    label: "bash (sandboxed)",
    description:
      `${directBash.description} Commands run inside the workspace sandbox by default. ` +
      "If a command genuinely needs blocked network access or access outside writable roots, retry with sandbox_permissions=require_escalated and provide a concise justification.",
    promptGuidelines: [
      ...(directBash.promptGuidelines ?? []),
      "Run bash commands with sandbox_permissions=use_default unless the sandbox blocks access required for the task.",
      "When a command genuinely needs blocked network access or files outside sandbox roots, retry with sandbox_permissions=require_escalated and a concise justification. Never request escalation merely for convenience.",
    ],
    parameters: permissionBashParameters(directBash.parameters) as typeof directBash.parameters,
    async execute(id, rawParams, signal, onUpdate, ctx) {
      activeContext = ctx;
      const params = rawParams as PermissionBashInput;
      const input = safeBashInput(params);
      const mode = approvals.getMode();

      if (mode === "full-access") {
        return directBash.execute(id, input, signal, onUpdate, ctx);
      }

      if (params.sandbox_permissions === "require_escalated") {
        if (!approvedEscalatedCalls.delete(id)) {
          throw new Error("Escalated execution was not approved");
        }
        return directBash.execute(id, input, signal, onUpdate, ctx);
      }

      if (!sandboxInitialized) {
        throw new Error(
          `Sandbox unavailable; refusing to run without protection${sandboxError ? `: ${sandboxError}` : ""}`,
        );
      }

      const sandboxedBash = createBashToolDefinition(ctx.cwd, {
        operations: createSandboxedBashOperations(id),
      });
      return sandboxedBash.execute(id, input, signal, onUpdate, ctx);
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    activeContext = ctx;
    if (approvals.getMode() === "full-access") return undefined;

    if (event.toolName === "bash") {
      const input = event.input as PermissionBashInput;
      if (input.sandbox_permissions !== "require_escalated") return undefined;
      if (!input.justification?.trim()) {
        return {
          block: true,
          reason: "Escalated commands require a concise justification",
        };
      }

      const decision = await approvals.authorize(
        commandPermissionRequest(input.command, input.justification),
        ctx,
      );
      if (!decision.allowed) {
        return {
          block: true,
          reason: `Escalated command denied: ${decision.reason}`,
        };
      }
      approvedEscalatedCalls.add(event.toolCallId);
      return undefined;
    }

    if (!FILE_POLICY_TOOLS.has(event.toolName)) return undefined;
    const input = event.input as Record<string, unknown>;
    const policy = filesystemApprovalPolicy(config);
    const initial = await evaluateToolPermission(
      event.toolName,
      input,
      ctx.cwd,
      policy,
    );
    if (!initial) return undefined;

    if (initial.request) {
      const decision = await approvals.authorize(initial.request, ctx);
      if (!decision.allowed) {
        return {
          block: true,
          reason: `${initial.request.kind} permission denied: ${decision.reason}`,
        };
      }
    }

    // Re-resolve after a potentially long approval prompt. Sequential tool
    // execution prevents another Pi tool in the batch from changing the path.
    const final = await evaluateToolPermission(
      event.toolName,
      input,
      ctx.cwd,
      policy,
    );
    if (!final) return undefined;
    if (final.request && final.request.key !== initial.request?.key) {
      const decision = await approvals.authorize(final.request, ctx);
      if (!decision.allowed) {
        return {
          block: true,
          reason: `${final.request.kind} permission denied: ${decision.reason}`,
        };
      }
    }

    stabilizeToolInput(event.toolName, input, final);
    return undefined;
  });

  pi.on("user_bash", async (event, ctx) => {
    activeContext = ctx;
    if (approvals.getMode() === "full-access") return undefined;

    try {
      await ensureSandbox(ctx);
    } catch (error) {
      const message = `Sandbox unavailable; refusing to run without protection: ${
        error instanceof Error ? error.message : String(error)
      }`;
      const blockedOperations: BashOperations = {
        async exec() {
          throw new Error(message);
        },
      };
      return { operations: blockedOperations };
    }
    return { operations: createSandboxedBashOperations(`user:${event.command}`) };
  });

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    config = loadConfig(ctx.cwd);
    const noSandbox = pi.getFlag("no-sandbox") as boolean;
    const mode = noSandbox ? "full-access" : configuredMode(config);
    approvals.setMode(mode);
    approvals.clearSessionGrants();
    approvedEscalatedCalls.clear();

    if (mode !== "full-access") {
      try {
        await ensureSandbox(ctx);
        ctx.ui.notify("Sandbox initialized", "info");
      } catch (error) {
        ctx.ui.notify(
          `Sandbox initialization failed; restricted commands will be blocked: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
      }
    } else if (noSandbox) {
      ctx.ui.notify("Full access enabled via --no-sandbox", "warning");
    } else if (config.enabled === false) {
      ctx.ui.notify("Full access enabled because sandbox config is disabled", "warning");
    } else {
      ctx.ui.notify("Full access enabled by sandbox defaultMode", "warning");
    }

    updateStatus(ctx);
  });

  pi.on("session_shutdown", async () => {
    activeContext = undefined;
    approvedEscalatedCalls.clear();
    if (sandboxInitialized || SandboxManager.isSandboxingEnabled()) {
      try {
        await SandboxManager.reset();
      } catch {
        // Cleanup is best-effort and idempotent.
      }
    }
    sandboxInitialized = false;
    sandboxInitialization = undefined;
  });

  pi.registerCommand("permissions", {
    description: "Select a permission mode or save it as the default",
    handler: async (_args, ctx) => {
      activeContext = ctx;
      if (!ctx.hasUI) {
        ctx.ui.notify("The permissions selector requires an interactive UI", "error");
        return;
      }

      const selection = await selectPermissionMode(ctx, approvals.getMode());
      if (!selection) return;

      const switched = await switchMode(
        selection.mode,
        ctx,
        selection.saveAsDefault,
      );
      if (!switched || !selection.saveAsDefault) return;

      try {
        const path = saveDefaultMode(selection.mode);
        ctx.ui.notify(
          `${getPermissionModeInfo(selection.mode).label} saved as the default in ${path}`,
          selection.mode === "full-access" ? "warning" : "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `Permissions changed for this session, but the default could not be saved: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("sandbox", {
    description: "Show sandbox and permissions configuration",
    handler: async (_args, ctx) => {
      activeContext = ctx;
      const info = getPermissionModeInfo(approvals.getMode());
      const lines = [
        "Permissions:",
        `  Mode: ${info.label}`,
        `  Sandbox: ${info.sandboxed ? (sandboxInitialized ? "active" : "unavailable") : "disabled"}`,
        ...(info.sandboxed && sandboxError ? [`  Error: ${sandboxError}`] : []),
        "",
        "Network:",
        `  Allowed: ${config.network.allowedDomains.join(", ") || "(none)"}`,
        `  Denied: ${config.network.deniedDomains.join(", ") || "(none)"}`,
        "",
        "Filesystem:",
        `  Deny Read: ${config.filesystem.denyRead.join(", ") || "(none)"}`,
        `  Allow Read: ${config.filesystem.allowRead?.join(", ") || "(none)"}`,
        `  Allow Write: ${config.filesystem.allowWrite.join(", ") || "(none)"}`,
        `  Deny Write: ${config.filesystem.denyWrite.join(", ") || "(none)"}`,
        `  Credential Files: ${config.credentials?.files?.length ?? 0}`,
      ];
      ctx.ui.notify(lines.join("\n"), info.sandboxed ? "info" : "warning");
    },
  });
}
