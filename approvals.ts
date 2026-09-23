import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "./modes.ts";
import type { PermissionRequest } from "./policy.ts";
import {
  reviewPermissionRequest,
  type ReviewDecision,
} from "./reviewer.ts";

export class ApprovalController {
  private mode: PermissionMode;
  private readonly sessionGrants = new Set<string>();
  private readonly reviewer: typeof reviewPermissionRequest;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    mode: PermissionMode,
    reviewer: typeof reviewPermissionRequest = reviewPermissionRequest,
  ) {
    this.mode = mode;
    this.reviewer = reviewer;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  setMode(mode: PermissionMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.sessionGrants.clear();
  }

  clearSessionGrants(): void {
    this.sessionGrants.clear();
  }

  authorize(request: PermissionRequest, ctx: ExtensionContext): Promise<ReviewDecision> {
    const operation = this.queue.then(() => this.authorizeNow(request, ctx));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async authorizeNow(
    request: PermissionRequest,
    ctx: ExtensionContext,
  ): Promise<ReviewDecision> {
    if (this.mode === "full-access") {
      return { allowed: true, reason: "Full access is active" };
    }
    if (this.sessionGrants.has(request.key)) {
      return { allowed: true, reason: "Allowed earlier for this session" };
    }

    if (this.mode === "auto") {
      const decision = await this.reviewer(request, ctx);
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Auto-review ${decision.allowed ? "approved" : "denied"} ${request.kind}: ${decision.reason}`,
          decision.allowed ? "info" : "warning",
        );
      }
      return decision;
    }

    if (!ctx.hasUI) {
      return {
        allowed: false,
        reason: "Permission denied because no interactive approval UI is available",
      };
    }

    const choice = await ctx.ui.select(
      `${request.title}\n\n${request.description}`,
      ["Allow once", "Allow for this session", "Deny"],
      { signal: ctx.signal },
    );

    if (choice === "Allow for this session") {
      this.sessionGrants.add(request.key);
      return { allowed: true, reason: "Allowed for this session" };
    }
    if (choice === "Allow once") {
      return { allowed: true, reason: "Allowed once" };
    }
    return { allowed: false, reason: "Denied by user" };
  }
}

