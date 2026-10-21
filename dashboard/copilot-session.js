import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MAX_RUNTIME_FRAME_BYTES,
  MAX_RUNTIME_REQUESTS,
  runtimePermissionPrompt,
  runtimeQuestionPrompt,
  runtimeRequestId
} from "./runtime-requests.js";

export function extensionLaunchProvider(bootstrap) {
  return {
    async resolve({ modulePath }) {
      if (typeof modulePath !== "string" || !isAbsolute(modulePath) ||
          !modulePath.endsWith(".mjs")) {
        throw new Error("Copilot supplied an unsupported extension entrypoint.");
      }
      return {
        launch: {
          executable: process.execPath,
          args: [bootstrap],
          env: { EXTENSION_PATH: modulePath }
        }
      };
    }
  };
}

function extensionBootstrapPath() {
  const platform = process.platform === "linux" &&
      !process.report.getReport().header.glibcVersionRuntime ? "linuxmusl" : process.platform;
  const require = createRequire(import.meta.resolve("@github/copilot-sdk"));
  const root = dirname(require.resolve(`@github/copilot-sdk-${platform}-${process.arch}/package.json`));
  return join(root, "preloads", "extension_bootstrap.mjs");
}

export async function runCopilotSession(config, { client, ask, output }) {
  const usage = {
    inputTokens: config.usage?.inputTokens ?? 0,
    cachedInputTokens: config.usage?.cachedInputTokens ?? 0,
    cacheWriteTokens: config.usage?.cacheWriteTokens ?? 0,
    outputTokens: config.usage?.outputTokens ?? 0
  };
  let streamed = false;
  const options = {
    sessionId: config.sessionId,
    workingDirectory: config.repository,
    agent: "fixlab:fixlab",
    enableConfigDiscovery: true,
    enableManagedSettings: true,
    extensionSdkPath: config.extensionSdkPath,
    streaming: true,
    additionalDirectories: config.additionalDirs,
    ...(config.model ? { model: config.model } : {}),
    ...(config.model === "hydrafusion" ? { enableExperimentalMode: true } : {}),
    onPermissionRequest: async (request) => {
      const prompt = runtimePermissionPrompt(request);
      const response = await ask(prompt);
      if (response.action === "allow" && !prompt.canApprove) {
        throw new Error("An unreviewable permission request cannot be approved.");
      }
      return response.action === "allow"
        ? { kind: "approve-once", approvedInteractively: true }
        : { kind: "reject" };
    },
    onUserInputRequest: async (request) => {
      const response = await ask(runtimeQuestionPrompt(request));
      if (response.action !== "answer") {
        throw new Error("The user cancelled the runtime question.");
      }
      return { answer: response.answer, wasFreeform: response.wasFreeform };
    }
  };
  try {
    await client.start();
    const session = config.resume
      ? await client.resumeSession(config.sessionId, options)
      : await client.createSession(options);
    const policy = await session.rpc.managedSettings.get();
    if (policy?.failClosed !== false) {
      throw new Error("Enterprise policy could not be determined; execution is blocked.");
    }
    session.on((event) => {
      if (event.type === "assistant.message_delta") {
        streamed = true;
        output("stdout", event.data.deltaContent);
      } else if (event.type === "assistant.message") {
        if (!streamed && event.data.content) {
          output("stdout", event.data.content);
        }
        streamed = false;
        output("stdout", "\n");
      } else if (event.type === "assistant.usage") {
        for (const [target, source] of [
          ["inputTokens", "inputTokens"], ["cachedInputTokens", "cacheReadTokens"],
          ["cacheWriteTokens", "cacheWriteTokens"], ["outputTokens", "outputTokens"]
        ]) {
          if (Number.isFinite(event.data[source]) && event.data[source] >= 0) {
            usage[target] += event.data[source];
          }
        }
        output("stdout", `\nTokens \u2191 ${usage.inputTokens} (${usage.cachedInputTokens} cached, ${usage.cacheWriteTokens} written) \u2022 \u2193 ${usage.outputTokens}\n`);
      }
    });
    await session.sendAndWait({ prompt: config.prompt }, 24 * 60 * 60 * 1000);
  } finally {
    const errors = await client.stop();
    if (errors.length > 0) {
      throw new Error("Copilot runtime shutdown failed; owned process containment must complete before resuming.");
    }
  }
}

async function main() {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Map();
  const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  let started = false;
  let task;
  let client;
  const cancel = () => {
    for (const { reject } of pending.values()) {
      reject(new Error("The dashboard disconnected or cancelled this request."));
    }
    pending.clear();
  };
  try {
    for await (const line of lines) {
      if (Buffer.byteLength(line) > MAX_RUNTIME_FRAME_BYTES) {
        throw new Error("Runtime input exceeded its size limit.");
      }
      const message = JSON.parse(line);
      if (!started) {
        if (message.type !== "start" || !message.sessionId || !message.repository ||
            typeof message.prompt !== "string" || !message.packageRoot) {
          throw new Error("A valid runtime start message is required.");
        }
        started = true;
        const { CopilotClient, RuntimeConnection } = await import("@github/copilot-sdk");
        message.extensionSdkPath = dirname(fileURLToPath(import.meta.resolve("@github/copilot-sdk")));
        client = new CopilotClient({
          connection: RuntimeConnection.forStdio({
            args: message.model === "hydrafusion" ? ["--experimental"] : []
          }),
          workingDirectory: message.repository,
          builtinPluginDirectories: [message.packageRoot],
          extensionLaunchProvider: extensionLaunchProvider(extensionBootstrapPath()),
          logLevel: "error"
        });
        task = runCopilotSession(message, {
          client,
          output: (stream, text) => emit({ type: "output", stream, text }),
          ask(request) {
            if (pending.size >= MAX_RUNTIME_REQUESTS) {
              return Promise.reject(new Error("Too many pending runtime requests."));
            }
            const id = runtimeRequestId();
            return new Promise((resolve, reject) => {
              pending.set(id, { resolve, reject });
              emit({ type: "request", ...request, id });
            });
          }
        }).then(() => {
          cancel();
          lines.close();
        }, (error) => {
          process.exitCode = 1;
          emit({ type: "error", message: error.message });
          cancel();
          lines.close();
        });
      } else if (message.type === "response" && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.action === "cancel") {
          request.reject(new Error("The user cancelled the runtime request."));
        } else {
          request.resolve(message);
        }
      } else {
        throw new Error("Unknown or stale runtime response.");
      }
    }
    cancel();
    await task;
  } catch (error) {
    process.exitCode = 1;
    emit({ type: "error", message: error.message });
    cancel();
    if (client) {
      await client.forceStop();
    }
  } finally {
    lines.close();
    process.stdin.destroy();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
