import { access, lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";

export interface FilesystemPolicyConfig {
  denyRead: string[];
  allowRead?: string[];
  allowWrite: string[];
  denyWrite: string[];
}

export interface PermissionRequest {
  key: string;
  kind: "command" | "filesystem" | "network";
  title: string;
  description: string;
  command?: string;
  paths?: string[];
  host?: string;
  port?: number;
  justification?: string;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

/** Match the path spellings accepted by Pi's built-in file tools. */
export function normalizeToolPath(path: string): string {
  let normalized = path.replace(UNICODE_SPACES, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~") return homedir();
  if (normalized.startsWith(`~${sep}`)) {
    return resolve(homedir(), normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
  return normalized;
}

export function resolvePolicyPath(path: string, cwd: string): string {
  const normalized = normalizeToolPath(path);
  return isAbsolute(normalized) ? resolve(normalized) : resolve(cwd, normalized);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Mirror the fallback spellings used by Pi's read tool before policy checks. */
async function resolvePiReadPath(path: string, cwd: string): Promise<string> {
  const resolved = resolvePolicyPath(path, cwd);
  if (await pathExists(resolved)) return resolved;

  const amPm = resolved.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
  if (amPm !== resolved && (await pathExists(amPm))) return amPm;

  const nfd = resolved.normalize("NFD");
  if (nfd !== resolved && (await pathExists(nfd))) return nfd;

  const curly = resolved.replace(/'/g, "\u2019");
  if (curly !== resolved && (await pathExists(curly))) return curly;

  const nfdCurly = nfd.replace(/'/g, "\u2019");
  if (nfdCurly !== resolved && (await pathExists(nfdCurly))) return nfdCurly;
  return resolved;
}

async function canonicalizeAbsolute(
  absolute: string,
  visited: Set<string>,
): Promise<string> {
  const normalized = resolve(absolute);
  if (visited.has(normalized)) {
    throw new Error(`Symlink cycle while resolving path: ${normalized}`);
  }
  visited.add(normalized);

  const root = parse(normalized).root;
  const components = relative(root, normalized).split(sep).filter(Boolean);
  let current = root;

  for (let index = 0; index < components.length; index += 1) {
    const component = components[index]!;
    const candidate = resolve(current, component);
    try {
      const stats = await lstat(candidate);
      if (stats.isSymbolicLink()) {
        const link = await readlink(candidate);
        const target = isAbsolute(link)
          ? resolve(link)
          : resolve(dirname(candidate), link);
        return canonicalizeAbsolute(
          resolve(target, ...components.slice(index + 1)),
          visited,
        );
      }
      current = await realpath(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return resolve(current, ...components.slice(index));
    }
  }

  return current;
}

/** Resolve symlinks component-by-component, including dangling leaf links. */
export async function canonicalizePath(path: string, cwd: string): Promise<string> {
  return canonicalizeAbsolute(resolvePolicyPath(path, cwd), new Set());
}

export function isWithinPath(path: string, root: string): boolean {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  const escapedSeparator = sep === "\\" ? "\\\\" : sep;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === sep) {
          source += `(?:.*${escapedSeparator})?`;
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += `[^${escapedSeparator}]*`;
      }
    } else if (character === "?") {
      source += `[^${escapedSeparator}]`;
    } else {
      source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function matchesPathPattern(candidate: string, pattern: string, cwd: string): boolean {
  const absolutePattern = resolvePolicyPath(pattern, cwd);
  const hasWildcard = /[*?]/.test(absolutePattern);
  if (hasWildcard) return globToRegExp(absolutePattern).test(candidate);
  return isWithinPath(candidate, absolutePattern);
}

async function canonicalizePattern(pattern: string, cwd: string): Promise<string> {
  const absolute = resolvePolicyPath(pattern, cwd);
  if (!/[*?]/.test(absolute)) return canonicalizePath(absolute, cwd);

  const wildcardIndex = absolute.search(/[*?]/);
  const separatorIndex = absolute.lastIndexOf(sep, wildcardIndex);
  const root = parse(absolute).root;
  const stablePrefix =
    separatorIndex < root.length ? root : absolute.slice(0, separatorIndex);
  const wildcardSuffix = absolute.slice(separatorIndex + 1);
  const canonicalPrefix = await canonicalizePath(stablePrefix, cwd);
  return resolve(canonicalPrefix, wildcardSuffix);
}

async function policyPatternVariants(
  patterns: string[],
  cwd: string,
): Promise<string[]> {
  const variants = await Promise.all(
    patterns.map(async (pattern) => [
      resolvePolicyPath(pattern, cwd),
      await canonicalizePattern(pattern, cwd),
    ]),
  );
  return [...new Set(variants.flat())];
}

function patternSpecificity(pattern: string): number {
  return pattern.replace(/[*?]/g, "").length;
}

export function extractPatchPaths(patch: string): string[] {
  const paths: string[] = [];
  const marker = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(patch)) !== null) {
    const path = match[1]?.trim();
    if (path) paths.push(path);
  }
  return [...new Set(paths)];
}

function toolPaths(toolName: string, input: Record<string, unknown>): {
  access: "read" | "write";
  paths: string[];
  recursive: boolean;
  syntax: "pi" | "pi-read" | "literal";
} | undefined {
  if (["read", "grep", "find", "ls"].includes(toolName)) {
    const path = typeof input.path === "string" ? input.path : ".";
    return {
      access: "read",
      paths: [path],
      recursive: toolName === "grep" || toolName === "find",
      syntax: toolName === "read" ? "pi-read" : "pi",
    };
  }

  if (["write", "edit"].includes(toolName) && typeof input.path === "string") {
    return {
      access: "write",
      paths: [input.path],
      recursive: false,
      syntax: "pi",
    };
  }

  if (toolName === "apply_patch" && typeof input.patch === "string") {
    return {
      access: "write",
      paths: extractPatchPaths(input.patch),
      recursive: false,
      syntax: "literal",
    };
  }

  return undefined;
}

export interface ToolPermissionEvaluation {
  access: "read" | "write";
  rawPaths: string[];
  lexicalPaths: string[];
  paths: string[];
  request?: PermissionRequest;
}

function readIsProtected(
  path: string,
  denyReadPatterns: string[],
  allowReadPatterns: string[],
  cwd: string,
): boolean {
  const matchingDenies = denyReadPatterns.filter((pattern) =>
    matchesPathPattern(path, pattern, cwd),
  );
  if (matchingDenies.length === 0) return false;

  const matchingAllows = allowReadPatterns.filter((pattern) =>
    matchesPathPattern(path, pattern, cwd),
  );
  const strongestDeny = Math.max(...matchingDenies.map(patternSpecificity));
  const strongestAllow = Math.max(-1, ...matchingAllows.map(patternSpecificity));
  return strongestDeny > strongestAllow;
}

function staticPatternPrefix(pattern: string): string {
  const wildcardIndex = pattern.search(/[*?]/);
  if (wildcardIndex < 0) return pattern;
  const separatorIndex = pattern.lastIndexOf(sep, wildcardIndex);
  const root = parse(pattern).root;
  return separatorIndex < root.length ? root : pattern.slice(0, separatorIndex);
}

function recursiveReadMayReachProtectedPath(
  root: string,
  denyReadPatterns: string[],
  allowReadPatterns: string[],
  cwd: string,
): boolean {
  for (const deny of denyReadPatterns) {
    if (!/[*?]/.test(deny)) {
      if (!isWithinPath(deny, root) && !isWithinPath(root, deny)) continue;
      const representative = isWithinPath(deny, root) ? deny : root;
      if (readIsProtected(representative, denyReadPatterns, allowReadPatterns, cwd)) {
        return true;
      }
      continue;
    }

    const prefix = staticPatternPrefix(deny);
    if (!isWithinPath(prefix, root) && !isWithinPath(root, prefix)) continue;
    if (readIsProtected(root, denyReadPatterns, allowReadPatterns, cwd)) return true;

    // A literal allow root covers every descendant with the same specificity.
    // If it is at least as specific as this deny, this deny cannot win below it.
    const strongestCoveringAllow = Math.max(
      -1,
      ...allowReadPatterns
        .filter((allow) => !/[*?]/.test(allow) && isWithinPath(root, allow))
        .map(patternSpecificity),
    );
    if (patternSpecificity(deny) > strongestCoveringAllow) return true;
  }
  return false;
}

export async function evaluateToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  policy: FilesystemPolicyConfig,
): Promise<ToolPermissionEvaluation | undefined> {
  const operation = toolPaths(toolName, input);
  if (!operation || operation.paths.length === 0) return undefined;

  const resolvedPaths = await Promise.all(
    operation.paths.map(async (path) => {
      return (
        operation.syntax === "pi-read"
          ? await resolvePiReadPath(path, cwd)
          : operation.syntax === "pi"
            ? resolvePolicyPath(path, cwd)
            : isAbsolute(path)
              ? resolve(path)
              : resolve(cwd, path)
      );
    }),
  );
  if (toolName === "apply_patch") {
    // Reject leaf symlinks before pinning can erase their lexical identity.
    for (const path of resolvedPaths) {
      try {
        if ((await lstat(path)).isSymbolicLink()) {
          throw new Error(`Cannot patch a symbolic link: ${path}`);
        }
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  const resolvedCwd = resolvePolicyPath(".", cwd);
  const canonicalCwd = await canonicalizeAbsolute(resolvedCwd, new Set());
  const lexicalPaths = await Promise.all(
    resolvedPaths.map(async (path) => {
      if (isWithinPath(path, resolvedCwd)) {
        return resolve(canonicalCwd, relative(resolvedCwd, path));
      }
      const canonicalParent = await canonicalizeAbsolute(dirname(path), new Set());
      return resolve(canonicalParent, parse(path).base);
    }),
  );
  const paths = await Promise.all(
    resolvedPaths.map((path) => canonicalizeAbsolute(path, new Set())),
  );

  if (operation.access === "read") {
    const denyReadPatterns = await policyPatternVariants(policy.denyRead, cwd);
    const allowReadPatterns = await policyPatternVariants(
      policy.allowRead ?? [],
      cwd,
    );
    const protectedPaths = paths.filter(
      (path, index) =>
        readIsProtected(
          resolvedPaths[index]!,
          denyReadPatterns,
          allowReadPatterns,
          cwd,
        ) ||
        readIsProtected(
          lexicalPaths[index]!,
          denyReadPatterns,
          allowReadPatterns,
          cwd,
        ) ||
        readIsProtected(path, denyReadPatterns, allowReadPatterns, cwd) ||
        (operation.recursive &&
          (recursiveReadMayReachProtectedPath(
            resolvedPaths[index]!,
            denyReadPatterns,
            allowReadPatterns,
            cwd,
          ) ||
            recursiveReadMayReachProtectedPath(
            lexicalPaths[index]!,
            denyReadPatterns,
            allowReadPatterns,
            cwd,
          ) ||
            recursiveReadMayReachProtectedPath(
              path,
              denyReadPatterns,
              allowReadPatterns,
              cwd,
            ))),
    );
    const request = protectedPaths.length === 0 ? undefined : {
      key: `filesystem:read:${protectedPaths.sort().join("|")}`,
      kind: "filesystem",
      title: "Read protected files?",
      description: `${toolName} wants to read protected path${protectedPaths.length === 1 ? "" : "s"}:\n${protectedPaths.map((path) => `  ${path}`).join("\n")}`,
      paths: protectedPaths,
    } satisfies PermissionRequest;
    return {
      access: operation.access,
      rawPaths: operation.paths,
      lexicalPaths,
      paths,
      request,
    };
  }

  const allowedRoots = await Promise.all(
    policy.allowWrite.map((path) => canonicalizePath(path, cwd)),
  );
  const denyWritePatterns = await policyPatternVariants(policy.denyWrite, cwd);
  const restrictedPaths = paths.filter((path, index) => {
    const explicitlyDenied = denyWritePatterns.some((pattern) =>
      matchesPathPattern(path, pattern, cwd) ||
      matchesPathPattern(resolvedPaths[index]!, pattern, cwd) ||
      matchesPathPattern(lexicalPaths[index]!, pattern, cwd),
    );
    const insideAllowedRoot = allowedRoots.some((root) => isWithinPath(path, root));
    return explicitlyDenied || !insideAllowedRoot;
  });
  const request = restrictedPaths.length === 0 ? undefined : {
    key: `filesystem:write:${restrictedPaths.sort().join("|")}`,
    kind: "filesystem",
    title: "Edit protected files?",
    description: `${toolName} wants to modify protected path${restrictedPaths.length === 1 ? "" : "s"}:\n${restrictedPaths.map((path) => `  ${path}`).join("\n")}`,
    paths: restrictedPaths,
  } satisfies PermissionRequest;
  return {
    access: operation.access,
    rawPaths: operation.paths,
    lexicalPaths,
    paths,
    request,
  };
}

export async function permissionRequestForTool(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  policy: FilesystemPolicyConfig,
): Promise<PermissionRequest | undefined> {
  return (await evaluateToolPermission(toolName, input, cwd, policy))?.request;
}

/** Pin path-argument tools to the canonical target that was policy-checked. */
export function stabilizeToolInput(
  toolName: string,
  input: Record<string, unknown>,
  evaluation: ToolPermissionEvaluation,
): void {
  if (
    ["read", "grep", "find", "ls", "write", "edit"].includes(toolName) &&
    evaluation.paths[0]
  ) {
    input.path = evaluation.paths[0];
    return;
  }

  if (toolName === "apply_patch" && typeof input.patch === "string") {
    const targets = new Map(
      evaluation.rawPaths.map((path, index) => [path, evaluation.paths[index]!]),
    );
    input.patch = input.patch.replace(
      /^(\*\*\* (?:Add File|Update File|Delete File|Move to): )(.+)$/gm,
      (line, prefix: string, rawPath: string) =>
        `${prefix}${targets.get(rawPath.trim()) ?? rawPath.trim()}`,
    );
  }
}

export function commandPermissionRequest(
  command: string,
  justification?: string,
): PermissionRequest {
  return {
    key: `command:${command}`,
    kind: "command",
    title: "Run outside the sandbox?",
    description: `Command:\n  ${command}${justification ? `\n\nReason:\n  ${justification}` : ""}`,
    command,
    justification,
  };
}

export function networkPermissionRequest(host: string, port?: number): PermissionRequest {
  const destination = port === undefined ? host : `${host}:${port}`;
  return {
    key: `network:${destination}`,
    kind: "network",
    title: "Allow network access?",
    description: `A sandboxed command wants to connect to:\n  ${destination}`,
    host,
    port,
  };
}

