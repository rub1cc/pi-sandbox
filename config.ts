import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { isPermissionMode, type PermissionMode } from "./modes.ts";
import { resolvePolicyPath } from "./policy.ts";

export interface SandboxConfig extends SandboxRuntimeConfig {
  /** Backwards-compatible switch. False starts the session in Full access. */
  enabled?: boolean;
  /** Session startup mode. /permissions can persist this global default. */
  defaultMode?: PermissionMode;
}

export const DEFAULT_CONFIG: SandboxConfig = {
  enabled: true,
  defaultMode: "ask",
  network: {
    allowedDomains: [
      "npmjs.org",
      "*.npmjs.org",
      "registry.npmjs.org",
      "registry.yarnpkg.com",
      "pypi.org",
      "*.pypi.org",
      "github.com",
      "*.github.com",
      "api.github.com",
      "raw.githubusercontent.com",
    ],
    deniedDomains: [],
  },
  filesystem: {
    denyRead: ["~/.ssh", "~/.aws", "~/.gnupg"],
    allowWrite: [".", "/tmp"],
    denyWrite: [".env", ".env.*", "*.pem", "*.key"],
  },
};

function readPartialConfig(path: string): Partial<SandboxConfig> {
  if (!existsSync(path)) return {};

  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Partial<SandboxConfig>;
  } catch (error) {
    console.error(`Warning: Could not parse ${path}: ${error}`);
    return {};
  }
}

export function mergeConfig(
  base: SandboxConfig,
  overrides: Partial<SandboxConfig>,
): SandboxConfig {
  const result: SandboxConfig = {
    ...base,
    ...overrides,
    network: { ...base.network, ...overrides.network },
    filesystem: { ...base.filesystem, ...overrides.filesystem },
  };

  if (!isPermissionMode(overrides.defaultMode)) {
    result.defaultMode = base.defaultMode;
  }

  return result;
}

export function loadConfig(cwd: string): SandboxConfig {
  const globalPath = globalSandboxConfigPath();
  const projectPath = join(cwd, CONFIG_DIR_NAME, "sandbox.json");
  const globalConfig = readPartialConfig(globalPath);
  const projectConfig = readPartialConfig(projectPath);

  return mergeConfig(mergeConfig(DEFAULT_CONFIG, globalConfig), projectConfig);
}

export function globalSandboxConfigPath(): string {
  return join(getAgentDir(), "extensions", "sandbox.json");
}

/** Update the persisted startup mode without discarding other settings. */
export function saveDefaultMode(
  mode: PermissionMode,
  path = globalSandboxConfigPath(),
): string {
  let saved: Record<string, unknown> = {};

  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${path} must contain a JSON object`);
    }
    saved = parsed as Record<string, unknown>;
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ ...saved, enabled: true, defaultMode: mode }, null, 2)}\n`,
    "utf-8",
  );
  return path;
}

export function configuredMode(config: SandboxConfig): PermissionMode {
  if (config.enabled === false) return "full-access";
  return config.defaultMode ?? "ask";
}

/**
 * The runtime resolves relative policy paths against process.cwd(). Pi sessions
 * can use a different cwd, so make every configured path explicit first.
 */
export function runtimeConfigForCwd(
  config: SandboxConfig,
  cwd: string,
  additionalDenyWrite: readonly string[] = [],
): SandboxRuntimeConfig {
  const { enabled: _enabled, defaultMode: _defaultMode, ...runtime } = config;
  const resolvePaths = (paths: readonly string[]) =>
    paths.map((path) => resolvePolicyPath(path, cwd));

  return {
    ...runtime,
    filesystem: {
      ...runtime.filesystem,
      denyRead: resolvePaths(runtime.filesystem.denyRead),
      allowRead: runtime.filesystem.allowRead
        ? resolvePaths(runtime.filesystem.allowRead)
        : undefined,
      allowWrite: resolvePaths(runtime.filesystem.allowWrite),
      denyWrite: resolvePaths([
        ...runtime.filesystem.denyWrite,
        ...additionalDenyWrite,
      ]),
    },
    credentials: runtime.credentials
      ? {
          ...runtime.credentials,
          files: runtime.credentials.files?.map((file) => ({
            ...file,
            path: resolvePolicyPath(file.path, cwd),
          })),
        }
      : undefined,
    ignoreViolations: runtime.ignoreViolations
      ? Object.fromEntries(
          Object.entries(runtime.ignoreViolations).map(([command, paths]) => [
            command,
            resolvePaths(paths),
          ]),
        )
      : undefined,
  };
}

