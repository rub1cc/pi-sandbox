# @rub1cc/pi-sandbox

This extension gives Pi a Codex-style permission selector while keeping
`sandbox/index.ts` as the sole owner of bash execution.

## Install

```bash
pi install npm:@rub1cc/pi-sandbox
```

Try it for one invocation without adding it to settings:

```bash
pi -e npm:@rub1cc/pi-sandbox
```

The package bundles the compatible `@rub1cc/pi-renderer` module used to render
bash calls. Install `@rub1cc/pi-renderer` separately when you also want its
rendering for Pi's other built-in tools.

For publishing, release `@rub1cc/pi-renderer@0.1.0` first, install that exact
version in this package, then pack or publish the sandbox so npm includes the
declared bundled dependency.

## Development

Run `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test` against the same Pi installation
used to load the extension. Standalone Bun tests use physical Node module
resolution, not Pi's host-module aliases. Avoid stale copies of
`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` in this package's
`node_modules`; link them to the installed host (or resolve them from the parent
workspace). Keep these host packages as peer dependencies, not bundled runtime
dependencies. For npm dependency installs, `--legacy-peer-deps` avoids installing
separate copies of the host peers.

## Permission modes

Run `/permissions` to change the active session mode:

| Mode | Command sandbox | Escalation reviewer |
| --- | --- | --- |
| Ask for approval | Enabled | User |
| Approve for me | Enabled | Independent model call |
| Full access | Disabled | None |

**Ask for approval** is the default. Commands run within the configured
filesystem and network policy. Unknown network destinations, explicit bash
escalations, protected reads, and protected writes require confirmation.

**Approve for me** keeps the same sandbox. Requests that would be shown to the
user are instead sent to a separate security-review model call. Review errors,
ambiguous responses, and unavailable models fail closed.

**Full access** bypasses command sandboxing and path approval checks. Selecting
it interactively always displays a warning. `--no-sandbox` and the legacy
`"enabled": false` setting start directly in this mode.

In `/permissions`, press Enter to use the highlighted mode for the current
session only. Press Ctrl+S to use it now and save it as the global default for
future sessions in `~/.pi/agent/extensions/sandbox.json`. Existing settings in
that file are preserved. Saving a mode also replaces the legacy
`"enabled": false` switch with `"enabled": true`, so `defaultMode` controls
startup behavior.

A project-level `<cwd>/.pi/sandbox.json` still takes precedence over the global
default. You can also set `defaultMode` to `"ask"`, `"auto"`, or
`"full-access"` in either config file manually.

## Bash escalation

The bash tool has two additional arguments:

- `sandbox_permissions`: `use_default` or `require_escalated`
- `justification`: why unrestricted execution is necessary

The model should use the sandbox first. If the sandbox blocks an operation that
is genuinely required, it can retry that command with `require_escalated`.
Approval applies to that command only unless the user chooses the session
option.

Network destinations already listed under `network.allowedDomains` are inside
the sandbox policy and do not prompt. Destinations under `deniedDomains` are
always denied by the runtime. Other destinations enter the active approval
flow.

## File-tool protection

The extension gates these tools before execution:

- Protected reads through `read`, `grep`, `find`, and `ls`
- Protected writes through `write` and `edit`
- Every path declared by `apply_patch`

`grep` and `find` are treated as recursive: searching a parent directory also
requires review when the search could reach a protected descendant. The file
tools, `apply_patch`, and bash use Pi's sequential execution mode, so another
tool call in the same model response cannot retarget a checked path before it
executes.

Files declared under the sandbox runtime's `credentials.files` configuration
also enter the protected-read approval flow because Pi's built-in file tools
run in the host process and cannot apply the runtime's credential masking.
The runtime's mandatory write protections are mirrored for file tools,
including shell startup files, editor configuration, agent instructions, Git
hooks, and Git configuration.

Path handling mirrors Pi's file tools, including `@` prefixes, `file://` URLs,
tilde expansion, Unicode spaces, and the read tool's filename fallbacks. Policy
rules are checked against both the normalized lexical path and its canonical
target, including dangling links. After review, direct file-tool arguments and
`apply_patch` headers are pinned to those canonical targets. `apply_patch` also
rejects paths that escape its working root through a symlink. Bash commands
remain protected by the OS-level sandbox itself.

Relative runtime configuration is converted to absolute paths using the Pi
session cwd before sandbox initialization; it is not left to the runtime's
process cwd.

## Configuration

Global and project configuration are merged in this order:

1. Built-in defaults
2. `~/.pi/agent/extensions/sandbox.json`
3. `<cwd>/.pi/sandbox.json`

Example:

```json
{
  "defaultMode": "ask",
  "network": {
    "allowedDomains": ["github.com", "*.github.com"],
    "deniedDomains": []
  },
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg"],
    "allowRead": [],
    "allowWrite": [".", "/tmp"],
    "denyWrite": [".env", ".env.*", "*.pem", "*.key"]
  }
}
```

Use `/sandbox` to inspect the effective mode and configuration.

## Limitations

- This extension currently enables OS command sandboxing on macOS and Linux.
  Restricted modes fail closed on unsupported platforms.
- File-tool checks cover the known Pi tools above. A third-party tool that
  performs its own filesystem writes must provide or implement its own policy
  integration.
- Canonical target pinning and sequential execution prevent races between Pi
  tool calls. They do not claim to defend against an unrelated hostile local
  process that can concurrently rename directories in the workspace.
- Auto-review is a model judgment, not a deterministic security guarantee. The
  OS sandbox remains the primary boundary.
- Auto-review model usage is separate from the main agent turn and may incur
  additional model usage.

