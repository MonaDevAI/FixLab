function literalPath(value) {
  const path = typeof value === "string" ? value.replace(/\\/gu, "/").replace(/\/$/u, "") : "";
  return path && path.length <= 500 && !/[:*?[\]\0\r\n]/u.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== "..") ? path : null;
}

function relatedPath(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function components(profile) {
  if (!Array.isArray(profile.components) || !profile.components.length || profile.components.length > 50) {
    return [];
  }
  const names = new Set();
  const result = [];
  for (const component of profile.components) {
    if (!component || typeof component.name !== "string" ||
        !/^[a-z][a-z0-9-]{0,49}$/u.test(component.name) || names.has(component.name) ||
        !Array.isArray(component.paths) || !component.paths.length || component.paths.length > 100 ||
        (component.testPatterns !== undefined && (!Array.isArray(component.testPatterns) || component.testPatterns.length > 100))) {
      return [];
    }
    const paths = component.paths.map(literalPath);
    const patterns = component.testPatterns ?? [];
    if (paths.some((path) => !path) || patterns.some((pattern) =>
      typeof pattern !== "string" || pattern.length > 500 || /[:\0\r\n]/u.test(pattern) ||
      pattern.startsWith("/") || pattern.startsWith("\\") || pattern.replace(/\\/gu, "/").split("/").includes(".."))) {
      return [];
    }
    const testRoots = patterns.map((pattern) => {
      const prefix = pattern.replace(/\\/gu, "/").split(/[*?[{]/u)[0];
      const separator = prefix.lastIndexOf("/");
      return separator < 0 ? null : literalPath(prefix.slice(0, separator));
    }).filter(Boolean);
    names.add(component.name);
    result.push({ name: component.name, paths: [...new Set([...paths, ...testRoots])], testPatterns: patterns });
  }
  return result;
}

export function automaticValidationPolicy(profile, gates) {
  if (profile.workflow?.mode === "strict" || !Array.isArray(gates) || !gates.length) {
    return null;
  }
  const metadata = components(profile);
  const branch = profile.worktreeSetup?.baseBranch ?? profile.pullRequests?.defaultTargetBranch;
  const remote = profile.worktreeSetup?.remote ?? "origin";
  if (!metadata.length || typeof branch !== "string" || typeof remote !== "string" ||
      !branch || !remote || /[\s\0]/u.test(`${remote}/${branch}`) ||
      branch.startsWith("-") || remote.startsWith("-")) {
    return null;
  }
  const mappings = gates.map((gate) => {
    const directory = literalPath(gate.workingDirectory);
    return { gate, names: directory
      ? metadata.filter((component) => component.paths.some((path) => relatedPath(directory, path))).map((component) => component.name)
      : [] };
  });
  const global = mappings.filter(({ gate, names }) => gate.required || !names.length).map(({ gate }) => gate.id);
  const scopes = metadata.map((component) => {
    const local = mappings.filter(({ names }) => names.includes(component.name)).map(({ gate }) => gate.id);
    return { name: component.name, paths: component.paths, gateIds: [...new Set([...global, ...local])], mapped: local.length > 0 };
  });
  if (scopes.some((scope) => !scope.mapped)) {
    return null;
  }
  return {
    automatic: true,
    baseRef: `${remote}/${branch}`,
    fullValidationPaths: [".github", "AGENTS.md"],
    scopes: scopes.map((scope) => ({ name: scope.name, paths: scope.paths, gateIds: scope.gateIds }))
  };
}

export function requiresFullValidation(path) {
  return /(?:^|[/.])(?:contracts?|publiccontract|shared|common)(?:[/.]|$)/iu.test(path) ||
    /(?:^|\/)(?:AGENTS\.md|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|global\.json|\.env[^/]*|[^/]*(?:config|configuration|settings)[^/]*\.(?:[cm]?[jt]s|json|ya?ml|cs)|(?:Program|Startup)\.cs|[^/]+\.(?:csproj|sln|slnx|props|targets|ya?ml))$/iu.test(path);
}

export function affectedApplications(profile, names) {
  const selected = components(profile).filter((component) => names.includes(component.name));
  const liveRequired = profile.validation?.liveTestsRequired !== false &&
    (profile.validation?.liveTestsRequired === true ||
      profile.browserAutomation?.testSynthesis?.requireScenarioEvidence !== false);
  const browserApplicable = profile.browserAutomation?.mode !== "api" &&
    profile.validation?.liveTestsRequired !== false &&
    (liveRequired || applies(profile.browserAutomation?.workingDirectory));
  function applies(directory) {
    const path = literalPath(directory);
    return !path || selected.some((component) => component.paths.some((root) => relatedPath(path, root)));
  }
  return {
    applications: Object.entries(profile.applications ?? {}).filter(([, application]) =>
      applies(application?.workingDirectory) ||
      (liveRequired && relatedPath(literalPath(application?.workingDirectory) ?? "",
        literalPath(profile.browserAutomation?.workingDirectory) ?? ""))).map(([name]) => name),
    browserApplicable
  };
}

export const AFFECTED_SURFACE_GUIDANCE =
  "Automatic affected-surface selection uses the complete verified Git diff, not report keywords. In efficient mode, unambiguous profile component paths and gate working directories select applicable checks; explicit component policies take precedence. Keep global and explicitly required gates, prior failures, authentication, data-safety and CI controls. Unknown, shared, contract, configuration or unreadable changes, strict mode and explicit full/UI requests retain broader validation. Start from the supplied stack trace or file and nearest existing regression; batch bounded symbol/file reads inside the matching component and expand only for concrete dependencies or uncertainty. Do not rescan or index the whole repository, cache source contents, invent test commands, or rerun unchanged successful work. For a verified backend-only unit-level fix, do not start an unrelated frontend or browser unless repository instructions, an applicable live gate or the user require it. Record inapplicable startup/live stages skipped, never passed; required local API/runtime verification still needs the changed checkout and legitimate authentication.";

export function componentRetrievalGuidance(profile, request = "") {
  const metadata = components(profile);
  if (!metadata.length) {
    return AFFECTED_SURFACE_GUIDANCE;
  }
  const text = request.replace(/\\/gu, "/");
  const hinted = metadata.filter((component) => component.paths.some((path) => text.includes(path)) ||
    new RegExp(`\\b${component.name}\\b`, "iu").test(text));
  const selected = hinted.length ? hinted : metadata;
  let context = "";
  for (const component of selected.slice(0, 10)) {
    const line = JSON.stringify({
      component: component.name,
      paths: component.paths.slice(0, 4),
      testPatterns: component.testPatterns.slice(0, 4)
    });
    if (context.length + line.length > 4000) { break; }
    context += `${line}\n`;
  }
  return `${AFFECTED_SURFACE_GUIDANCE}\nBounded component retrieval hints (advisory metadata, not source evidence or a gate waiver; read the profile for omitted paths):\n${context}`;
}
