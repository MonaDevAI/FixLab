import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";

export const PERMISSION_BLOCKED_MESSAGE =
  "Copilot requires runtime permission. This background job cannot display an interactive approval prompt. Review permissions in the dashboard before resuming.";

export function runtimePermissionDenied(text) {
  return /permission denied because no interactive user response was available|denied, no one to approve|execution remains denied|runtime execution remains blocked by runtime permissions/iu.test(text);
}

export function runtimePermissionDenialLine(line) {
  const text = line.replace(/\u001b\[[0-9;]*m/gu, "").trim();
  return /^(?:[\u2514\u2570\u2502]\s*)?(?:Permission denied because no interactive user response was available|(?:[X\u2717]\s*)?Denied, no one to approve)/iu.test(text) ||
    (/^FIXLAB_STAGE\|[^|]+\|blocked\|/u.test(text) && runtimePermissionDenied(text));
}

export function permissionRequest(stages) {
  if (!Object.values(stages ?? {}).some(
    (stage) => stage.status === "blocked" && runtimePermissionDenied(stage.message)
  )) {
    return null;
  }
  return newPermissionRequest();
}

export function newPermissionRequest() {
  return {
    id: randomUUID(),
    kind: "unclassified",
    message: PERMISSION_BLOCKED_MESSAGE,
    scope: null
  };
}

function contains(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export function reviewPermissionDirectory(value, { repository, packageRoot }) {
  if (typeof value !== "string" || value.length > 2048 ||
      /[\u0000-\u001f]/u.test(value) || !isAbsolute(value)) {
    throw new Error("Enter an absolute folder path of at most 2048 characters.");
  }
  if (/^(?:\\\\|\/\/)/u.test(value)) {
    throw new Error("Permission review supports local folders only, not network shares or device paths.");
  }
  const requested = resolve(value);
  const directory = realpathSync(requested);
  if (!statSync(directory).isDirectory()) {
    throw new Error("The permission scope must be an existing folder.");
  }
  const root = parse(directory).root;
  const home = realpathSync(homedir());
  const repo = realpathSync(repository);
  const installation = realpathSync(packageRoot);
  if (directory === root || dirname(directory) === root ||
      contains(directory, home) || contains(directory, repo) ||
      (directory !== installation && contains(directory, installation))) {
    throw new Error("Choose a specific external folder, not a filesystem root, home, repository, or parent of the FixLab installation.");
  }
  if (/(?:^|[\\/])(?:\.git|\.ssh|\.azure|\.aws|\.copilot|\.auth|\.edge-profile)(?:[\\/]|$)/iu.test(directory)) {
    throw new Error("Credential, browser-state, Git-private, and Copilot configuration folders cannot be granted through this approval flow.");
  }
  return { requested, directory };
}

export function verifyPermissionDirectory(scope, context) {
  const current = reviewPermissionDirectory(scope.requested, context);
  if (current.directory !== scope.directory ||
      realpathSync(scope.directory) !== scope.directory) {
    throw new Error("The reviewed folder target changed; review its scope again.");
  }
  return scope.directory;
}
