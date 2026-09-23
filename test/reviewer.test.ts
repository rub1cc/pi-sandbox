import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionRequest } from "../policy.ts";
import { reviewPermissionRequest } from "../reviewer.ts";

const request: PermissionRequest = {
  key: "network:example.com:443",
  kind: "network",
  title: "Allow network access?",
  description: "Connect to example.com:443",
  host: "example.com",
  port: 443,
};

function reviewerContext(
  responseText: string,
  stopReason: string = "stop",
): ExtensionContext {
  return {
    model: { id: "review-model" },
    signal: undefined,
    sessionManager: {
      getBranch() {
        return [
          {
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: "Fetch the public example page" }],
            },
          },
        ];
      },
    },
    modelRegistry: {
      async complete() {
        return {
          stopReason,
          content: [{ type: "text", text: responseText }],
        };
      },
    },
  } as unknown as ExtensionContext;
}

test("Auto-review accepts a strict allow decision", async () => {
  const decision = await reviewPermissionRequest(
    request,
    reviewerContext('{"decision":"allow","reason":"Narrow public fetch"}'),
  );
  assert.deepEqual(decision, {
    allowed: true,
    reason: "Narrow public fetch",
  });
});

test("Auto-review fails closed on invalid output", async () => {
  const decision = await reviewPermissionRequest(
    request,
    reviewerContext("I think this is fine."),
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /no decision/i);
});

test("Auto-review rejects decisions from incomplete model responses", async () => {
  const decision = await reviewPermissionRequest(
    request,
    reviewerContext(
      '{"decision":"allow","reason":"This JSON happened to finish early"}',
      "length",
    ),
  );
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /did not complete normally/i);
});

test("Auto-review fails closed without an active model", async () => {
  const decision = await reviewPermissionRequest(request, {
    model: undefined,
  } as ExtensionContext);
  assert.equal(decision.allowed, false);
  assert.match(decision.reason, /no active model/i);
});

