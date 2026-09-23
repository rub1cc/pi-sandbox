export const PERMISSION_MODE_IDS = ["ask", "auto", "full-access"] as const;

export type PermissionMode = (typeof PERMISSION_MODE_IDS)[number];

export interface PermissionModeInfo {
  id: PermissionMode;
  label: string;
  description: string;
  sandboxed: boolean;
}

export const PERMISSION_MODES: readonly PermissionModeInfo[] = [
  {
    id: "ask",
    label: "Ask for approval",
    description: "Sandboxed; you review requests that cross the boundary",
    sandboxed: true,
  },
  {
    id: "auto",
    label: "Approve for me",
    description: "Sandboxed; a separate reviewer model decides escalation requests",
    sandboxed: true,
  },
  {
    id: "full-access",
    label: "Full access",
    description: "No sandbox and no approval prompts",
    sandboxed: false,
  },
] as const;

export function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    (PERMISSION_MODE_IDS as readonly string[]).includes(value)
  );
}

export function getPermissionModeInfo(mode: PermissionMode): PermissionModeInfo {
  return PERMISSION_MODES.find((candidate) => candidate.id === mode)!;
}

