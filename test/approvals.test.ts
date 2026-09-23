import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ApprovalController } from "../approvals.ts";
import type { PermissionRequest } from "../policy.ts";

const request: PermissionRequest = {
  key: "command:git push",
  kind: "command",
  title: "Run outside the sandbox?",
  description: "Command:\n  git push",
  command: "git push",
};

function context(
  choices: string[],
  notifications: string[] = [],
): ExtensionContext {
  return {
    hasUI: true,
    signal: undefined,
    ui: {
      async select() {
        return choices.shift();
      },
      notify(message: string) {
        notifications.push(message);
      },
    },
  } as unknown as ExtensionContext;
}

test("manual mode can grant an exact request for the session", async () => {
  const controller = new ApprovalController("ask");
  const ctx = context(["Allow for this session"]);

  assert.equal((await controller.authorize(request, ctx)).allowed, true);
  assert.equal((await controller.authorize(request, ctx)).allowed, true);
});

test("manual mode fails closed without an approval UI", async () => {
  const controller = new ApprovalController("ask");
  const ctx = { hasUI: false } as ExtensionContext;
  const decision = await controller.authorize(request, ctx);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /no interactive approval UI/i);
});

test("auto mode delegates to the reviewer", async () => {
  const notifications: string[] = [];
  const controller = new ApprovalController("auto", async () => ({
    allowed: true,
    reason: "Narrow and necessary",
  }));
  const decision = await controller.authorize(
    request,
    context([], notifications),
  );

  assert.equal(decision.allowed, true);
  assert.match(notifications[0] ?? "", /Auto-review approved/);
});

test("changing modes clears session grants", async () => {
  const controller = new ApprovalController("ask");
  const ctx = context(["Allow for this session", "Deny"]);
  assert.equal((await controller.authorize(request, ctx)).allowed, true);

  controller.setMode("full-access");
  controller.setMode("ask");
  assert.equal((await controller.authorize(request, ctx)).allowed, false);
});

