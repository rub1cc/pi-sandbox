import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEFAULT_CONFIG,
  runtimeConfigForCwd,
  saveDefaultMode,
  type SandboxConfig,
} from "../config.ts";

test("runtime policy paths are anchored to the Pi session cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-config-"));
  const config = {
    ...DEFAULT_CONFIG,
    filesystem: {
      ...DEFAULT_CONFIG.filesystem,
      denyRead: ["private"],
      allowRead: ["public"],
      allowWrite: ["."],
      denyWrite: [".env", "**/.key"],
    },
    credentials: {
      files: [{ path: "credentials/token", mode: "deny" }],
    },
    ignoreViolations: {
      "test *": ["generated"],
    },
  } as SandboxConfig;

  const runtime = runtimeConfigForCwd(config, cwd, [".git/hooks"]);

  assert.deepEqual(runtime.filesystem.denyRead, [join(cwd, "private")]);
  assert.deepEqual(runtime.filesystem.allowRead, [join(cwd, "public")]);
  assert.deepEqual(runtime.filesystem.allowWrite, [cwd]);
  assert.deepEqual(runtime.filesystem.denyWrite, [
    join(cwd, ".env"),
    join(cwd, "**/.key"),
    join(cwd, ".git/hooks"),
  ]);
  assert.equal(runtime.credentials?.files?.[0]?.path, join(cwd, "credentials/token"));
  assert.deepEqual(runtime.ignoreViolations, {
    "test *": [join(cwd, "generated")],
  });
});

test("saving a default mode preserves existing global settings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-config-"));
  const path = join(cwd, "nested", "sandbox.json");
  await mkdir(join(cwd, "nested"));
  await writeFile(
    path,
    JSON.stringify({
      enabled: false,
      network: { allowedDomains: ["example.com"] },
    }),
  );

  assert.equal(saveDefaultMode("auto", path), path);

  const saved = JSON.parse(await readFile(path, "utf-8"));
  assert.deepEqual(saved, {
    enabled: true,
    network: { allowedDomains: ["example.com"] },
    defaultMode: "auto",
  });
});

test("saving a default mode creates missing parent directories", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-config-"));
  const path = join(cwd, "new", "config", "sandbox.json");

  saveDefaultMode("ask", path);

  assert.deepEqual(JSON.parse(await readFile(path, "utf-8")), {
    enabled: true,
    defaultMode: "ask",
  });
});

test("saving a default mode refuses to overwrite invalid JSON", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-config-"));
  const path = join(cwd, "sandbox.json");
  await writeFile(path, "not json");

  assert.throws(() => saveDefaultMode("full-access", path), SyntaxError);
  assert.equal(await readFile(path, "utf-8"), "not json");
});
