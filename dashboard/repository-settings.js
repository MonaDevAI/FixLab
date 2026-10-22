import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, parse } from "node:path";
import { createExecutorLease } from "./executor-lease.js";
import { SETUP_PROFILE_PATH, REPOSITORY_PROMPT_NAMES, setupPath, browserConfigurationErrors } from "./repository-setup.js";
import { safeRuntimeText } from "./runtime-requests.js";
import { configuredWorkflow } from "./workflow-policy.js";

export const REPOSITORY_SETTING_FIELDS = [
  { key: "efficientWorkflow", label: "Use efficient delivery by default: focused checks, then draft PR?", type: "boolean" },
  { key: "readyPublication", label: "Publish ready for review instead of draft? Required checks and publication consent still apply.", type: "boolean" },
  { key: "unitTestsAfterPr", label: "Run broader local unit tests after PR creation?", type: "boolean" },
  { key: "optionalBuilds", label: "Run optional builds after PR creation? Saved once, not asked each stage.", type: "boolean" },
  { key: "name", label: "What should this repository be called?", type: "text" },
  { key: "frontendDirectory", label: "Where is the frontend? Use a repository-relative folder.", type: "text" },
  { key: "frontendCommand", label: "Which command starts the frontend?", type: "text" },
  { key: "frontendPort", label: "Which local port does the frontend use?", type: "number", max: 65535 },
  { key: "frontendHealthUrl", label: "What is its local health URL?", type: "text" },
  { key: "backendEnabled", label: "Configure a local backend too?", type: "boolean" },
  { key: "backendDirectory", label: "Where is the backend?", type: "text", when: "backendEnabled" },
  { key: "backendCommand", label: "Which command starts the backend?", type: "text", when: "backendEnabled" },
  { key: "backendPort", label: "Which local port does the backend use?", type: "number", max: 65535, when: "backendEnabled" },
  { key: "backendHealthUrl", label: "What is the backend's local health URL?", type: "text", when: "backendEnabled" },
  { key: "browserDirectory", label: "Where should Playwright run?", type: "text" },
  { key: "browserCommand", label: "Which command runs the browser tests?", type: "text" },
  { key: "authenticationRequired", label: "Does browser validation require sign-in?", type: "boolean" },
  { key: "authenticationCommand", label: "Which repository command opens sign-in? Never enter credentials.", type: "text", when: "authenticationRequired" },
  { key: "authenticationPaths", label: "Which relative authentication status paths should be checked? Separate them with commas; do not paste file contents.", type: "text", when: "authenticationRequired" },
  { key: "environments", label: "Which non-production environments are allowed? Separate them with commas.", type: "text" },
  { key: "targetBranch", label: "Which branch should pull requests target?", type: "text" },
  { key: "branchUserId", label: "What developer alias should own new branches?", type: "text" },
  { key: "branchPrefix", label: "Which branch prefix template should be used? Use {userId} for the alias.", type: "text" },
  { key: "idleTimeoutMinutes", label: "How many idle minutes may an executor wait? Choose 1 to 120.", type: "number", max: 120 }
];
const split = (value) => value.split(",").map((part) => part.trim()).filter(Boolean);

export function localRepository(value) {
  if (typeof value !== "string" || value.length > 2048 || !isAbsolute(value)) {
    throw new Error("Choose an existing local Git repository using its absolute folder path.");
  }
  const root = realpathSync.native(value);
  if (!lstatSync(root).isDirectory() || root === parse(root).root) {
    throw new Error("A filesystem root is not a repository workspace.");
  }
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: root, encoding: "utf8", shell: false, windowsHide: true, timeout: 10000, maxBuffer: 65536
  });
  if (git.status !== 0 || realpathSync.native(git.stdout.trim()) !== root) {
    throw new Error("Select the root of an existing Git working tree, not a subfolder or bare repository.");
  }
  return root;
}

function readConfiguration(repository) {
  const root = localRepository(repository);
  const path = setupPath(root, SETUP_PROFILE_PATH);
  let raw = null;
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 65536) {
      throw new Error("The repository profile must be a regular JSON file no larger than 64 KiB.");
    }
    raw = readFileSync(path);
  }
  let profile = {};
  if (raw) {
    try {
      profile = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new Error("Repair the existing repository profile's JSON before editing settings.");
    }
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      throw new Error("The repository profile must be a JSON object.");
    }
  }
  const directory = lstatSync(root);
  const revision = createHash("sha256").update(`${root}\0${directory.dev}\0${directory.ino}\0`)
    .update(raw ?? "profile-not-created").digest("hex");
  return { root, path, profile, revision, exists: raw !== null };
}

export function inspectRepositorySettings(repository) {
  const info = readConfiguration(repository);
  const p = info.profile;
  const f = p.applications?.frontend ?? {};
  const b = p.applications?.backend ?? {};
  const browser = p.browserAutomation ?? {};
  const apiOnly = browser.mode === "api";
  const auth = browser.authentication ?? {};
  const workflow = configuredWorkflow(p);
  const values = {
    efficientWorkflow: workflow.mode === "efficient",
    readyPublication: workflow.publication === "ready",
    unitTestsAfterPr: workflow.unitTestsAfterPr,
    optionalBuilds: workflow.optionalBuilds,
    name: p.name ?? basename(info.root),
    frontendDirectory: f.workingDirectory ?? (existsSync(join(info.root, "frontend")) ? "frontend" : "."),
    frontendCommand: f.command ?? "npm start", frontendPort: f.port ?? 3000,
    frontendHealthUrl: f.healthUrl ?? "http://127.0.0.1:3000",
    backendEnabled: Boolean(p.applications?.backend), backendDirectory: b.workingDirectory ?? ".",
    backendCommand: b.command ?? "dotnet run", backendPort: b.port ?? 5000,
    backendHealthUrl: b.healthUrl ?? "http://127.0.0.1:5000/health",
    browserDirectory: browser.workingDirectory ?? f.workingDirectory ?? ".",
    browserCommand: browser.testCommand ?? "npx playwright test",
    authenticationRequired: auth.required ?? false, authenticationCommand: auth.command ?? "",
    authenticationPaths: (auth.statusPaths ?? []).join(", "),
    environments: (Array.isArray(p.environments) ? p.environments :
      p.environments && typeof p.environments === "object" ? Object.keys(p.environments) : ["local", "dev", "sit"]).join(", "),
    targetBranch: p.pullRequests?.defaultTargetBranch ?? "main",
    branchUserId: p.pullRequests?.branchNaming?.userId ?? "",
    branchPrefix: p.pullRequests?.branchNaming?.prefixTemplate ?? "users/{userId}",
    idleTimeoutMinutes: p.validation?.agentIdleTimeoutMinutes ?? 20
  };
  for (const value of Object.values(values)) {
    if (typeof value === "string" && (!safeRuntimeText(value, 2048) ||
        /--(?:password|passwd|secret|token|cookie|api-key|authorization)(?:=|\s)/i.test(value))) {
      throw new Error("Editable settings contain sensitive or oversized values. Remove credentials from profile commands before using this editor.");
    }
  }
  return { repository: info.root, revision: info.revision, exists: info.exists,
    fields: apiOnly
      ? REPOSITORY_SETTING_FIELDS.filter((field) => !field.key.startsWith("frontend"))
      : REPOSITORY_SETTING_FIELDS, values };
}

function configuredProfile(root, original, values) {
  const apiOnly = original.browserAutomation?.mode === "api";
  if (!values || typeof values !== "object" || Array.isArray(values) ||
      Object.keys(values).some((key) => !REPOSITORY_SETTING_FIELDS.some((field) => field.key === key))) {
    throw new Error("Only the displayed repository settings may be updated.");
  }
  for (const field of REPOSITORY_SETTING_FIELDS) {
    if (apiOnly && field.key.startsWith("frontend")) { continue; }
    if (field.when && values[field.when] === false) { continue; }
    const value = values[field.key];
    if (field.type === "boolean" ? typeof value !== "boolean"
      : field.type === "number" ? !Number.isInteger(value) || value < 1 || value > field.max
        : !safeRuntimeText(value, 2048) || !value.trim() ||
          /--(?:password|passwd|secret|token|cookie|api-key|authorization)(?:=|\s)/i.test(value)) {
      throw new Error(`Invalid setting: ${field.key}. Use a non-sensitive value of the displayed type.`);
    }
  }
  const directory = (value) => {
    const path = setupPath(root, value);
    if (!existsSync(path) || !lstatSync(path).isDirectory()) {
      throw new Error("Application and browser working directories must already exist inside the repository.");
    }
    return value;
  };
  const application = (prefix, previous) => {
    const url = new URL(values[`${prefix}HealthUrl`]);
    if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1"].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash) {
      throw new Error("Application health URLs must be credential-free loopback HTTP(S) URLs without query strings.");
    }
    return { ...previous, workingDirectory: directory(values[`${prefix}Directory`]),
      command: values[`${prefix}Command`], port: values[`${prefix}Port`], healthUrl: url.href };
  };
  const environments = split(values.environments);
  if (!environments.length || environments.length > 12 || environments.some((name) =>
    !/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(name) || /^(?:prod|production)(?:$|[-_])/i.test(name))) {
    throw new Error("Choose at most 12 named non-production environments.");
  }
  const environmentDefinitions = original.environments && !Array.isArray(original.environments) &&
    typeof original.environments === "object" ? original.environments : null;
  if (environmentDefinitions && environments.some((name) => !Object.hasOwn(environmentDefinitions, name))) {
    throw new Error("Configure new structured environment definitions in the repository profile before enabling them here.");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(values.branchUserId) ||
      !/^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(values.targetBranch) ||
      values.targetBranch.includes("..")) {
    throw new Error("Use a safe developer alias and pull-request target branch.");
  }
  const prefix = values.branchPrefix.replaceAll("{userId}", values.branchUserId);
  if (!/^[a-z0-9][a-z0-9._/-]{0,199}$/i.test(prefix) || prefix.includes("..")) {
    throw new Error("Use a safe branch prefix, with only the optional {userId} placeholder.");
  }
  if (original.browserAutomation?.dataSafety?.productionAllowed === true) {
    throw new Error("This editor cannot change a profile permitting production operations. Review its safety policy separately.");
  }
  const browserDirectory = directory(values.browserDirectory);
  const statusPaths = values.authenticationRequired ? split(values.authenticationPaths) : [];
  if (values.authenticationRequired && (!statusPaths.length || statusPaths.length > 8)) {
    throw new Error("Authenticated browser setup requires 1 to 8 relative status paths.");
  }
  for (const path of statusPaths) { setupPath(setupPath(root, browserDirectory), path); }
  const applications = { ...original.applications };
  if (!apiOnly) { applications.frontend = application("frontend", original.applications?.frontend); }
  if (apiOnly && !values.backendEnabled) {
    throw new Error("API-only Playwright validation requires a configured backend.");
  }
  if (values.backendEnabled) { applications.backend = application("backend", original.applications?.backend); }
  else { delete applications.backend; }
  return {
    ...original, version: original.version ?? 1, name: values.name, applications,
    workflow: configuredWorkflow({ workflow: {
      mode: values.efficientWorkflow ? "efficient" : "strict",
      publication: values.readyPublication ? "ready" : "draft",
      unitTestsAfterPr: values.unitTestsAfterPr, optionalBuilds: values.optionalBuilds
    } }),
    validation: { ...original.validation, agentIdleTimeoutMinutes: values.idleTimeoutMinutes },
    browserAutomation: {
      package: "@playwright/test", ...(!apiOnly ? { browser: "chromium" } : {}), ...original.browserAutomation,
      workingDirectory: browserDirectory, testCommand: values.browserCommand,
      testSynthesis: original.browserAutomation?.testSynthesis ?? {
        enabled: true, defaultDataSource: "synthetic-intercepted", mutationMode: "intercepted", requireScenarioEvidence: true
      },
      authentication: { ...original.browserAutomation?.authentication,
        required: values.authenticationRequired, command: values.authenticationRequired ? values.authenticationCommand : "",
        statusPaths },
      dataSafety: { policy: "Use synthetic data and intercept mutations; real writes require separate explicit authorization.",
        ...original.browserAutomation?.dataSafety, productionAllowed: false }
    },
    environments: environmentDefinitions
      ? Object.fromEntries(environments.map((name) => [name, environmentDefinitions[name]])) : environments,
    pullRequests: { ...original.pullRequests, defaultTargetBranch: values.targetBranch,
      requireConfirmation: original.pullRequests?.requireConfirmation ?? true,
      branchNaming: { ...original.pullRequests?.branchNaming,
        userId: values.branchUserId, prefixTemplate: values.branchPrefix } }
  };
}

export function planRepositorySettings({ repository, revision, values, install, packageRoot, validate }) {
  const info = readConfiguration(repository);
  if (revision !== info.revision) { throw new Error("Repository settings changed. Reload and review a new plan."); }
  const profile = configuredProfile(info.root, info.profile, values);
  if (Buffer.byteLength(`${JSON.stringify(profile, null, 2)}\n`) > 65536) {
    throw new Error("The updated repository profile would exceed the 64 KiB settings limit.");
  }
  const validation = validate(profile);
  const errors = [...(validation.ok ? [] : [validation.detail]), ...browserConfigurationErrors(profile, info.root)];
  if (errors.length) { throw new Error(`Profile configuration is incomplete: ${errors.join("; ")}`); }
  const assets = install ? [
    ...REPOSITORY_PROMPT_NAMES.map((name) => ({ name: join(".github", "prompts", name),
      source: join(packageRoot, "prompts", name) })),
    { name: join(".github", "agents", "fixlab-autofix.agent.md"),
      source: join(packageRoot, "templates", "fixlab-autofix.agent.md") }
  ].filter((asset) => {
    const path = setupPath(info.root, asset.name);
    if (!existsSync(path)) { return true; }
    if (!lstatSync(path).isFile()) { throw new Error("Existing FixLab scaffolding must use regular non-symlink files."); }
    return false;
  }) : [];
  return { id: randomUUID(), createdAt: Date.now(), repository: info.root, revision,
    values, profile, assets, files: [...assets.map((asset) => asset.name), SETUP_PROFILE_PATH] };
}

export function applyRepositorySettings(plan, ownerId) {
  const lease = createExecutorLease(plan.repository, ownerId).acquire(plan.id);
  let temporary = null;
  try {
    const current = readConfiguration(plan.repository);
    if (current.revision !== plan.revision) { throw new Error("The repository changed after review; no settings were saved."); }
    for (const asset of plan.assets) {
      const path = setupPath(plan.repository, asset.name);
      if (existsSync(path)) { throw new Error("Setup files changed after review. Review a new plan before applying."); }
    }
    for (const asset of plan.assets) {
      const path = setupPath(plan.repository, asset.name);
      mkdirSync(dirname(path), { recursive: true });
      setupPath(plan.repository, asset.name);
      copyFileSync(asset.source, path, constants.COPYFILE_EXCL);
    }
    const path = setupPath(plan.repository, SETUP_PROFILE_PATH);
    mkdirSync(dirname(path), { recursive: true });
    setupPath(plan.repository, SETUP_PROFILE_PATH);
    const candidate = `${path}.${randomUUID()}.tmp`;
    const descriptor = openSync(candidate, "wx", 0o600);
    temporary = candidate;
    try {
      writeFileSync(descriptor, `${JSON.stringify(plan.profile, null, 2)}\n`);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, path);
    temporary = null;
    return { saved: true, repository: plan.repository, files: plan.files };
  } finally {
    try {
      if (temporary) { unlinkSync(temporary); }
    } finally {
      lease.release();
    }
  }
}
