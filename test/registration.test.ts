import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { codexBashRenderers } from "@rub1cc/pi-renderer/renderers";
import registerSandbox from "../index.ts";

test("sandbox owns bash and composes the scoped renderer package", () => {
  const tools: any[] = [];
  const handlers: Array<[string, unknown]> = [];
  registerSandbox({
    registerFlag() {},
    registerTool(tool: unknown) {
      tools.push(tool);
    },
    on(name: string, handler: unknown) {
      handlers.push([name, handler]);
      return () => {};
    },
    registerCommand() {},
    getFlag() {
      return false;
    },
  } as unknown as ExtensionAPI);

  assert.equal(tools.length, 1);
  const bash = tools[0];
  assert.equal(bash.name, "bash");
  assert.equal(bash.label, "bash (sandboxed)");
  assert.equal(bash.renderShell, "self");
  assert.equal(bash.renderCall, codexBashRenderers.renderCall);
  assert.equal(bash.renderResult, codexBashRenderers.renderResult);
  assert.equal(bash.executionMode, "sequential");
  assert.equal(typeof bash.execute, "function");
  assert.equal(handlers.some(([name]) => name === "user_bash"), true);
});
