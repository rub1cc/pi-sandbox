import assert from "node:assert/strict";
import test from "node:test";
import {
  getPermissionModeInfo,
  isPermissionMode,
  PERMISSION_MODES,
} from "../modes.ts";

test("defines the three Codex-style permission modes", () => {
  assert.deepEqual(
    PERMISSION_MODES.map((mode) => mode.id),
    ["ask", "auto", "full-access"],
  );
  assert.equal(getPermissionModeInfo("ask").label, "Ask for approval");
  assert.equal(getPermissionModeInfo("auto").label, "Approve for me");
  assert.equal(getPermissionModeInfo("full-access").sandboxed, false);
});

test("validates permission mode ids", () => {
  assert.equal(isPermissionMode("ask"), true);
  assert.equal(isPermissionMode("auto"), true);
  assert.equal(isPermissionMode("full-access"), true);
  assert.equal(isPermissionMode("dangerously-open"), false);
  assert.equal(isPermissionMode(undefined), false);
});

