import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createExecutorLease } from "../../../dashboard/executor-lease.js";

const [repository, evidence] = process.argv.slice(2);
const owner = createExecutorLease(repository, randomUUID());
process.send({ type: "ready" });
process.once("message", () => {
  try {
    const acquisition = owner.acquire(randomUUID());
    const executor = spawn(process.execPath, [
      "-e",
      "const fs = require('node:fs'); fs.appendFileSync(process.argv[1], process.pid + '\\n'); process.send('started'); setInterval(() => fs.appendFileSync(process.argv[1] + '.child', 'active\\n'), 20);",
      evidence
    ], { detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    acquisition.update("running", executor.pid);
    executor.once("message", () => process.send({ type: "acquired" }));
    process.once("message", (message) => {
      if (message && typeof message === "object" && "crash" in message && message.crash === true) {
        process.send({ type: "orphan", pid: executor.pid }, () => process.exit(0));
        return;
      }
      executor.once("exit", () => {
        acquisition.release();
        process.disconnect();
      });
      executor.kill();
    });
  } catch (error) {
    process.send({ type: "reserved", message: error.message });
    process.disconnect();
  }
});
