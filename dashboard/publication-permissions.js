import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { safeRuntimeText } from "./runtime-requests.js";
import { runtimeSourceName } from "./runtime-permission-policy.js";

export function publicationDestination(value) {
  if (typeof value !== "string") { return null; }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      url.search || url.hash || /%|\\/.test(url.pathname)) {
    return null;
  }
  const parts = url.pathname.replace(/\/$/, "").split("/").slice(1);
  if (parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || [".", ".."].includes(part))) {
    return null;
  }
  if (url.hostname === "github.com" && parts.length === 2) {
    const repository = parts.join("/").replace(/\.git$/, "");
    return { provider: "github", repository: repository.toLowerCase(),
      url: `https://github.com/${repository.toLowerCase()}` };
  }
  if (url.hostname === "dev.azure.com" && parts.length === 4 && parts[2] === "_git") {
    return { provider: "azure", organization: `https://dev.azure.com/${parts[0]}`,
      project: parts[1], repository: parts[3],
      url: `https://dev.azure.com/${parts[0]}/${parts[1]}/_git/${parts[3]}` };
  }
  return null;
}

// Deliberately exclude shell composition, aliases, implicit destinations and provider defaults.
export function publicationCommand(command) {
  if (!safeRuntimeText(command, 8192) || /[\r\n`$;&|<>()%!]/.test(command)) { return null; }
  const tokens = command.match(/'[^']*'|"[^"]*"|[^\s'"]+/g);
  if (!tokens || tokens.join(" ") !== command) { return null; }
  const args = tokens.map((token) => /^['"]/.test(token) ? token.slice(1, -1) : token);
  if (args.length === 4 && args[0] === "git" && args[1] === "commit" &&
      args[2] === "-m" && args[3].trim() && !args[3].startsWith("-")) {
    return { operation: "commit" };
  }
  if (args.length === 4 && args[0] === "git" && args[1] === "push" &&
      args[2] === "origin" && /^HEAD:refs\/heads\/[A-Za-z0-9_./-]+$/.test(args[3])) {
    return { operation: "push", source: args[3].slice("HEAD:refs/heads/".length) };
  }
  const github = args.slice(0, 3).join(" ") === "gh pr create";
  const azure = args.slice(0, 4).join(" ") === "az repos pr create";
  if (!github && !azure) { return null; }
  const options = {};
  for (let index = github ? 3 : 4; index < args.length; index += 2) {
    const key = args[index];
    if (Object.hasOwn(options, key)) { return null; }
    if (github && key === "--draft") {
      options[key] = true;
      index--;
    } else {
      if (args[index + 1] === undefined || args[index + 1].startsWith("--")) { return null; }
      options[key] = args[index + 1];
    }
  }
  const required = github
    ? ["--repo", "--head", "--base", "--title", "--body"]
    : ["--organization", "--project", "--repository", "--source-branch", "--target-branch",
      "--title", "--description", "--draft", "--detect", "--output"];
  if (required.some((key) => typeof options[key] !== "string" || !options[key].trim()) ||
      Object.keys(options).some((key) => !required.includes(key) && !(github && key === "--draft")) ||
      (azure && (options["--detect"] !== "false" || options["--output"] !== "json" ||
        !["true", "false"].includes(options["--draft"])))) {
    return null;
  }
  return {
    operation: "pr",
    destination: publicationDestination(github ? options["--repo"] :
      `${options["--organization"]}/${options["--project"]}/_git/${options["--repository"]}`),
    source: options[github ? "--head" : "--source-branch"],
    target: options[github ? "--base" : "--target-branch"],
    draft: github ? options["--draft"] === true : options["--draft"] === "true"
  };
}

function git(repository, args) {
  const result = spawnSync("git", args, {
    cwd: repository, encoding: "utf8", shell: false, windowsHide: true,
    timeout: 2000, maxBuffer: 256 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error("Publication scope could not be verified; review this command manually.");
  }
  return result.stdout.trim();
}

export function createPublicationPermissions(repository, protectedPaths = []) {
  let consent = null;
  let lastReview = null;
  const eligible = (request) => request.kind === "shell" && request.canOfferSessionApproval === true &&
    !request.managedApprovalRequired && !request.requestSandboxBypass &&
    !request.requestSandboxPermissive && !request.sandboxPathGrant &&
    !request.warning && !request.hasWriteFileRedirection &&
    Array.isArray(request.possiblePaths) && Array.isArray(request.possibleUrls) &&
    request.possiblePaths.every((path) => path === repository &&
      (!request.resolvedPaths?.[path] || request.resolvedPaths[path] === repository));
  const snapshot = () => {
    const root = realpathSync.native(repository);
    if (!isAbsolute(repository) || repository !== root || lstatSync(repository).isSymbolicLink()) {
      return null;
    }
    const configCount = Number(process.env.GIT_CONFIG_COUNT ?? 0);
    if (!Number.isInteger(configCount) || configCount < 0 || configCount > 32) { return null; }
    for (let index = 0; index < configCount; index++) {
      const key = process.env[`GIT_CONFIG_KEY_${index}`];
      const value = process.env[`GIT_CONFIG_VALUE_${index}`];
      if (!((key === "core.fsmonitor" && value === "false") ||
          (key === "safe.bareRepository" && ["all", "explicit"].includes(value)) ||
          (key === "credential.interactive" && ["false", "never"].includes(value)))) {
        return null;
      }
    }
    if (Object.keys(process.env).some((key) =>
      /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG(?:_SYSTEM|_GLOBAL|_NOSYSTEM)?)$/i.test(key)) ||
        git(root, ["rev-parse", "--show-toplevel"]).replace(/\\/g, "/") !== root.replace(/\\/g, "/")) {
      return null;
    }
    const pushConfig = spawnSync("git", ["config", "--get-regexp",
      "^(push\\.(followtags|pushoption)|remote\\.origin\\.(mirror|receivepack))$"], {
      cwd: root, encoding: "utf8", shell: false, windowsHide: true, timeout: 2000, maxBuffer: 8192
    });
    if (pushConfig.error || pushConfig.status !== 1) { return null; }
    const branch = git(root, ["symbolic-ref", "--short", "HEAD"]);
    const urls = git(root, ["remote", "get-url", "--push", "--all", "origin"]).split(/\r?\n/);
    const destination = urls.length === 1 ? publicationDestination(urls[0]) : null;
    if (!destination || git(root, ["diff", "--name-only"]).length ||
        git(root, ["ls-files", "--stage"]).split("\n").some((line) =>
          line && !/^(?:100644|100755) [a-f0-9]+ 0\t/.test(line))) { return null; }
    const head = git(root, ["rev-parse", "HEAD"]);
    const tree = git(root, ["write-tree"]);
    const profile = git(root, ["hash-object", "--no-filters", ".github/fixlab/repository-profile.json"]);
    return { root, branch, destination, head, tree, profile };
  };
  const changedPaths = (base) => git(repository, [
    "diff", "--cached", "--name-only", "--no-renames", "-z", base
  ]).split("\0").filter(Boolean);
  const safeChange = (path) => {
    const parts = path.split(/[\\/]/);
    if (!path || /[\u0000-\u001f:]/.test(path) || parts.some((part, index) =>
      part === ".." || part.startsWith(".") ||
      /^(?:node_modules|vendor|bin|obj|dist|build|artifacts|test-results|playwright-report)$/i.test(part) ||
      /auth|secret|credential|token|cookie|password|storage.?state|private|environment|appsettings/i
        .test(index === parts.length - 1 ? runtimeSourceName(part) : part))) {
      return false;
    }
    const absolute = resolve(repository, path);
    const suffix = relative(repository, absolute);
    if (!suffix || isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) {
      return false;
    }
    if (protectedPaths.some((protectedRoot) => {
      const suffix = relative(protectedRoot, absolute);
      return !suffix || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
    })) { return false; }
    let current = realpathSync.native(repository);
    for (const part of parts) {
      current = resolve(current, part);
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink() || (current === absolute && (!stat.isFile() || stat.nlink !== 1))) { return false; }
      } catch (error) {
        if (error.code === "ENOENT") {
          return /^(?:100644|100755) blob /.test(git(repository, ["ls-tree", "HEAD", "--", path]));
        }
        throw error;
      }
    }
    const size = Number(git(repository, ["cat-file", "-s", `:${path}`]));
    return Number.isInteger(size) && size <= 256 * 1024 &&
      safeRuntimeText(git(repository, ["cat-file", "blob", `:${path}`]), 256 * 1024);
  };
  return {
    clear() { consent = null; lastReview = null; },
    eligible(request, prompt) {
      return prompt.canApprove && eligible(request) && publicationCommand(request.fullCommandText) !== null;
    },
    review(request, readiness) {
      lastReview = null;
      const command = publicationCommand(request.fullCommandText);
      if (!eligible(request) || command?.operation !== "commit" || readiness?.ready !== true) { return null; }
      const state = snapshot();
      if (!state || state.branch !== readiness.source || !readiness.target ||
          request.resolvedWorkingDirectory !== state.root || request.possibleUrls.length) { return null; }
      const paths = changedPaths(state.head);
      if (!paths.length || paths.length > 30 || paths.some((path) => !safeChange(path))) { return null; }
      const key = JSON.stringify({ ...state, readiness, paths });
      if (key.length > 6000) { return null; }
      lastReview = key;
      return { scope: "publication-batch", key };
    },
    grant(reviewed) {
      if (reviewed?.scope !== "publication-batch" || !lastReview || reviewed.key !== lastReview) {
        throw new Error("Publication consent requires this executor's current reviewed checkpoint.");
      }
      consent = JSON.parse(lastReview);
      lastReview = null;
    },
    allows(request, readiness) {
      const command = publicationCommand(request.fullCommandText);
      if (!eligible(request) || !command || !consent ||
          JSON.stringify(readiness) !== JSON.stringify(consent.readiness)) { return false; }
      const state = snapshot();
      if (!state || request.resolvedWorkingDirectory !== consent.root ||
          ["root", "branch", "tree", "profile"].some((key) => state[key] !== consent[key]) ||
          JSON.stringify(state.destination) !== JSON.stringify(consent.destination) ||
          request.possibleUrls.some((url) => ![state.destination.url, state.destination.organization].includes(url))) {
        return false;
      }
      if (command.operation === "commit") { return state.head === consent.head; }
      if (state.head === consent.head ||
          git(repository, ["rev-list", "--parents", "-n", "1", "HEAD"]) !== `${state.head} ${consent.head}` ||
          git(repository, ["rev-parse", "HEAD^{tree}"]) !== consent.tree ||
          git(repository, ["diff", "--cached", "--name-only"]).length) { return false; }
      if (command.operation === "push") { return command.source === consent.branch; }
      if (command.destination?.provider === "github" &&
          ((process.env.GH_HOST && process.env.GH_HOST !== "github.com") ||
            (process.env.GH_REPO && publicationDestination(process.env.GH_REPO)?.url !== consent.destination.url))) {
        return false;
      }
      return command.destination?.url === consent.destination.url &&
        command.source === consent.branch && command.target === readiness.target &&
        command.draft === (readiness.publication === "draft");
    }
  };
}
