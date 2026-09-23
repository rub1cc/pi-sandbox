import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  createLocalBashOperations,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";

export function createSandboxedBashOperations(commandId?: string): BashOperations {
  const local = createLocalBashOperations();
  return {
    async exec(command, cwd, options) {
      let wrapped = false;
      const attributionKey = commandId ?? command;
      try {
        const sandboxedCommand = await SandboxManager.wrapWithSandbox(
          command,
          undefined,
          undefined,
          options.signal,
          { commandId: attributionKey, commandText: command },
        );
        wrapped = true;
        const result = await local.exec(sandboxedCommand, cwd, options);
        if (result.exitCode !== 0) {
          const annotation = SandboxManager.annotateStderrWithSandboxFailures(
            attributionKey,
            "",
          ).trim();
          if (annotation) options.onData(Buffer.from(`\n${annotation}\n`));
        }
        return result;
      } finally {
        // Older already-loaded sandbox-runtime modules do not expose the
        // per-command cleanup hook. Reloading an extension does not evict ESM
        // dependencies, so keep upgraded sessions compatible until restart.
        if (wrapped) SandboxManager.cleanupAfterCommand?.();
      }
    },
  };
}

