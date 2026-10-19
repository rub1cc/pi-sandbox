import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
  canonicalizePath,
  commandPermissionRequest,
  evaluateToolPermission,
  extractPatchPaths,
  isWithinPath,
  networkPermissionRequest,
  permissionRequestForTool,
  stabilizeToolInput,
  type FilesystemPolicyConfig,
} from "../policy.ts";

const policy = (cwd: string): FilesystemPolicyConfig => ({
  denyRead: [join(cwd, "secrets")],
  allowRead: [],
  allowWrite: [cwd],
  denyWrite: [".env", "*.pem"],
});

test("extracts every affected apply_patch path", () => {
  const patch = `*** Begin Patch
*** Add File: src/new.ts
+new
*** Update File: src/old.ts
*** Move to: src/moved.ts
@@
-old
+new
*** Delete File: src/gone.ts
*** End Patch`;

  assert.deepEqual(extractPatchPaths(patch), [
    "src/new.ts",
    "src/old.ts",
    "src/moved.ts",
    "src/gone.ts",
  ]);
});

test("rejects apply_patch leaf symlinks before target pinning", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-patch-link-"));
  try {
    await writeFile(join(cwd, "target.txt"), "keep\n");
    await symlink("target.txt", join(cwd, "link.txt"));
    await symlink("missing.txt", join(cwd, "dangling.txt"));
    for (const file of ["link.txt", "dangling.txt"]) {
      await assert.rejects(evaluateToolPermission("apply_patch", {
        patch: `*** Begin Patch\n*** Delete File: ${file}\n*** End Patch`,
      }, cwd, policy(cwd)), /Cannot patch a symbolic link/);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("allows ordinary writes inside a configured root", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
  const request = await permissionRequestForTool(
    "write",
    { path: "src/file.ts" },
    cwd,
    policy(cwd),
  );
  assert.equal(request, undefined);
});

test("requires approval outside writable roots and for denied names", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-sandbox-outside-"));

  const outsideRequest = await permissionRequestForTool(
    "edit",
    { path: join(outside, "file.ts") },
    cwd,
    policy(cwd),
  );
  assert.equal(outsideRequest?.kind, "filesystem");
  assert.deepEqual(outsideRequest?.paths, [
    await canonicalizePath(join(outside, "file.ts"), cwd),
  ]);

  const deniedRequest = await permissionRequestForTool(
    "write",
    { path: ".env" },
    cwd,
    policy(cwd),
  );
  assert.equal(deniedRequest?.title, "Edit protected files?");
});

test("requires approval before reading protected paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
  await mkdir(join(cwd, "secrets"));
  const request = await permissionRequestForTool(
    "read",
    { path: "secrets/token" },
    cwd,
    policy(cwd),
  );
  assert.equal(request?.title, "Read protected files?");
});

test("honors narrow allowRead exceptions but keeps narrower denies", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
  const publicDir = join(cwd, "public");
  const secretsDir = join(publicDir, "secrets");
  await mkdir(publicDir);
  await mkdir(secretsDir);
  const readPolicy: FilesystemPolicyConfig = {
    denyRead: [cwd, secretsDir],
    allowRead: [publicDir],
    allowWrite: [cwd],
    denyWrite: [],
  };

  assert.equal(
    await permissionRequestForTool(
      "read",
      { path: join(publicDir, "guide.md") },
      cwd,
      readPolicy,
    ),
    undefined,
  );
  assert.equal(
    (
      await permissionRequestForTool(
        "read",
        { path: join(secretsDir, "token") },
        cwd,
        readPolicy,
      )
    )?.title,
    "Read protected files?",
  );
});

test("canonicalizes the stable prefix of absolute deny globs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
  const request = await permissionRequestForTool(
    "write",
    { path: join(cwd, "secret.pem") },
    cwd,
    {
      denyRead: [],
      allowRead: [],
      allowWrite: [cwd],
      denyWrite: [join(dirname(cwd), "*", "*.pem")],
    },
  );
  assert.equal(request?.title, "Edit protected files?");
});

test("double-star globs match both root and nested paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
  const globPolicy: FilesystemPolicyConfig = {
    denyRead: [],
    allowRead: [],
    allowWrite: [cwd],
    denyWrite: ["**/.token"],
  };

  for (const path of [".token", "nested/.token"]) {
    const request = await permissionRequestForTool(
      "write",
      { path },
      cwd,
      globPolicy,
    );
    assert.equal(request?.title, "Edit protected files?");
  }
});

test("canonicalization catches writes through a symlinked directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-sandbox-outside-"));
  await symlink(outside, join(cwd, "linked"));

  const canonical = await canonicalizePath("linked/new.txt", cwd);
  assert.equal(canonical, await canonicalizePath(join(outside, "new.txt"), cwd));
  assert.equal(isWithinPath(canonical, cwd), false);

  const request = await permissionRequestForTool(
    "write",
    { path: "linked/new.txt" },
    cwd,
    policy(cwd),
  );
  assert.equal(request?.kind, "filesystem");
});

test("symlink targets cannot discard lexical deny rules", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-sandbox-outside-"));
  await mkdir(join(cwd, "secrets"));
  await writeFile(join(outside, "token"), "secret");
  await symlink(join(outside, "token"), join(cwd, "secrets", "token"));
  await symlink(join(outside, "new-cert"), join(cwd, "secret.pem"));

  assert.equal(
    (
      await permissionRequestForTool(
        "read",
        { path: "secrets/token" },
        cwd,
        policy(cwd),
      )
    )?.title,
    "Read protected files?",
  );
  assert.equal(
    (
      await permissionRequestForTool(
        "write",
        { path: "secret.pem" },
        cwd,
        policy(cwd),
      )
    )?.title,
    "Edit protected files?",
  );
});

test("absolute lexical globs survive symlinked path components", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
  const lexicalRoot = await mkdtemp(join(tmpdir(), "pi-sandbox-lexical-"));
  const targetRoot = await mkdtemp(join(tmpdir(), "pi-sandbox-target-"));
  const alias = join(lexicalRoot, "alias");
  await symlink(targetRoot, alias);

  const request = await permissionRequestForTool(
    "write",
    { path: join(alias, "blocked.pem") },
    cwd,
    {
      denyRead: [],
      allowRead: [],
      allowWrite: [targetRoot],
      denyWrite: [join(lexicalRoot, "*", "blocked.pem")],
    },
  );
  assert.equal(request?.title, "Edit protected files?");
});

test("canonicalization follows dangling leaf symlinks", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-sandbox-outside-"));
  const target = join(outside, "not-created-yet.txt");
  await symlink(target, join(cwd, "dangling"));

  assert.equal(
    await canonicalizePath("dangling", cwd),
    await canonicalizePath(target, cwd),
  );
  assert.equal(
    (
      await permissionRequestForTool(
        "write",
        { path: "dangling" },
        cwd,
        policy(cwd),
      )
    )?.title,
    "Edit protected files?",
  );
});

test("normalizes the same path spellings as Pi file tools", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
  const ordinary = join(cwd, "space dir", "file.txt");
  const canonicalOrdinary = await canonicalizePath(ordinary, cwd);

  assert.equal(await canonicalizePath(`@${ordinary}`, cwd), canonicalOrdinary);
  assert.equal(
    await canonicalizePath(pathToFileURL(ordinary).href, cwd),
    canonicalOrdinary,
  );
  assert.equal(
    await canonicalizePath(join(cwd, "space\u00a0dir", "file.txt"), cwd),
    canonicalOrdinary,
  );
  assert.equal(await canonicalizePath("~", cwd), await canonicalizePath(homedir(), cwd));
});

test("policy-checks the fallback path that Pi read will actually open", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-sandbox-outside-"));
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "secret");
  await symlink(secret, join(cwd, "capture’s.txt"));

  const request = await permissionRequestForTool(
    "read",
    { path: "capture's.txt" },
    cwd,
    {
      ...policy(cwd),
      denyRead: [outside],
    },
  );
  assert.equal(request?.title, "Read protected files?");
  assert.deepEqual(request?.paths, [await canonicalizePath(secret, cwd)]);
});

test("pins path tool input to the target that was checked", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
  const input: Record<string, unknown> = { path: `@${join(cwd, "new.txt")}` };
  const evaluation = await evaluateToolPermission("write", input, cwd, policy(cwd));
  assert.ok(evaluation);

  stabilizeToolInput("write", input, evaluation);
  assert.equal(input.path, await canonicalizePath(join(cwd, "new.txt"), cwd));
});

test("treats apply_patch headers as literal paths", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
  const request = await permissionRequestForTool(
    "apply_patch",
    {
      patch: `*** Begin Patch
*** Add File: @../literal-name/file.txt
+content
*** End Patch`,
    },
    cwd,
    policy(cwd),
  );

  assert.equal(request, undefined);
});

test("pins apply_patch headers to the targets that were checked", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
  const input: Record<string, unknown> = {
    patch: `*** Begin Patch
*** Add File: src/new.ts
+content
*** End Patch`,
  };
  const evaluation = await evaluateToolPermission(
    "apply_patch",
    input,
    cwd,
    policy(cwd),
  );
  assert.ok(evaluation);

  stabilizeToolInput("apply_patch", input, evaluation);
  assert.match(
    String(input.patch),
    new RegExp(`^\\*\\*\\* Add File: ${evaluation.paths[0]}$`, "m"),
  );
});

test("recursive search roots require approval for protected descendants", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-sandbox-policy-"));
  await mkdir(join(cwd, "secrets"));

  for (const toolName of ["grep", "find"]) {
    const request = await permissionRequestForTool(
      toolName,
      { path: "." },
      cwd,
      policy(cwd),
    );
    assert.equal(request?.title, "Read protected files?");
  }

  assert.equal(
    await permissionRequestForTool("ls", { path: "." }, cwd, policy(cwd)),
    undefined,
  );
});

test("creates stable command and network approval requests", () => {
  assert.equal(
    commandPermissionRequest("git push", "Publish the branch").key,
    "command:git push",
  );
  assert.equal(
    networkPermissionRequest("example.com", 443).key,
    "network:example.com:443",
  );
});

