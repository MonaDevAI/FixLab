import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";
import { createStructuredOutput, sanitize } from "./structured-command.js";

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MIN_OUTPUT_BYTES = 2000;

export function compressShellToolResult(input, environment = process.env) {
  if (environment.FIXLAB_DASHBOARD_OUTPUT_COMPRESSION !== "1" ||
      input.sessionId !== environment.FIXLAB_OUTPUT_SESSION_ID ||
      !/(?:powershell|bash|shell)/iu.test(input.toolName ?? "") ||
      input.toolResult?.resultType !== "success" ||
      typeof input.toolResult.textResultForLlm !== "string") {
    return {};
  }
  const source = input.toolResult.textResultForLlm;
  const args = typeof input.toolArgs === "string"
    ? input.toolArgs : JSON.stringify(input.toolArgs ?? {});
  if (/\bevidence\b.*\bshow\b/u.test(args) ||
      (/\b(?:PASS|FAIL|REUSED|OUTPUT) fixlab exec:/u.test(source) && source.includes("Context:"))) {
    return {};
  }
  const redacted = sanitize(source);
  if (Buffer.byteLength(source) < MIN_OUTPUT_BYTES && redacted === source) {
    return {};
  }
  const repository = environment.FIXLAB_OUTPUT_REPOSITORY;
  if (!repository || !/^[0-9a-f-]{36}$/iu.test(input.sessionId)) {
    throw new Error("Dashboard command compression requires repository and session ownership.");
  }
  const fingerprint = createHash("sha256").update(args).digest("hex").slice(0, 16);
  const output = createStructuredOutput({
    repository,
    command: `${input.toolName} [${fingerprint}]`,
    cwd: relative(repository, input.cwd ?? repository) || ".",
    stage: "runtime-output",
    tool: input.toolName,
    sessionId: input.sessionId
  });
  output.write("stdout", `${redacted}\n`);
  const compact = output.finish({ status: null, outcome: "captured-tool-output" });
  return {
    modifiedResult: {
      ...input.toolResult,
      textResultForLlm: compact.summary
    },
    additionalContext: "FixLab replaced verbose shell output before model consumption. Command success is not inferred from tool transport success. Inspect the printed bounded evidence command when exact returned data is needed."
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let content = "";
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_INPUT_BYTES) {
        throw new Error("Output-compression hook input exceeded its 8 MiB safety limit.");
      }
      content += chunk;
    }
    process.stdout.write(`${JSON.stringify(compressShellToolResult(JSON.parse(content)))}\n`);
  } catch (error) {
    process.stderr.write(`FixLab output compression failed: ${sanitize(error.message)}\n`);
    process.exitCode = 1;
  }
}
