import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { localRepository, SETUP_PROFILE_PATH, setupPath } from "./repository-setup.js";

const fields = new Set(["id", "repository", "application", "url", "environment"]);

function localUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      !url.port || url.username || url.password || url.search || url.hash) {
    throw new Error("Linked application URLs must use credential-free loopback HTTP(S) with an explicit port.");
  }
  return url;
}

export function configuredLinkedApplications(profile) {
  const links = profile?.linkedApplications === undefined ? [] : profile.linkedApplications;
  if (!Array.isArray(links) || links.length > 8) {
    throw new Error("linkedApplications must be an array of at most eight local application references.");
  }
  const ids = new Set();
  for (const link of links) {
    if (!link || typeof link !== "object" || Array.isArray(link) ||
        Object.keys(link).some((key) => !fields.has(key)) ||
        typeof link.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(link.id) ||
        ids.has(link.id) || typeof link.repository !== "string" ||
        link.repository.length > 2048 || !isAbsolute(link.repository) ||
        link.application !== "frontend" || link.environment !== "local" ||
        typeof link.url !== "string" || link.url.length > 2048) {
      throw new Error("Each linked application needs a unique id, absolute repository root, frontend application, local environment and loopback URL; unknown fields are not supported.");
    }
    if (localUrl(link.url).pathname !== "/") {
      throw new Error("A linked application's URL must identify its root origin.");
    }
    ids.add(link.id);
  }
  return links;
}

function permitsLocal(profile) {
  const environments = Array.isArray(profile.environments)
    ? profile.environments : Object.keys(profile.environments ?? {});
  return environments.includes("local") &&
    profile.browserAutomation?.dataSafety?.productionAllowed === false;
}

export function resolveLinkedApplications(repository, profile) {
  const links = configuredLinkedApplications(profile);
  if (links.length === 0) { return []; }
  const root = localRepository(repository);
  const sourceIdentity = lstatSync(root);
  return links.map((link) => {
    const target = localRepository(link.repository);
    if (target === root) {
      throw new Error("Linked applications must belong to a separate repository workspace.");
    }
    const path = setupPath(target, SETUP_PROFILE_PATH);
    const info = lstatSync(path);
    if (!info.isFile() || info.nlink !== 1 || info.size > 65536) {
      throw new Error("A linked repository profile must be an unlinked regular JSON file no larger than 64 KiB.");
    }
    const raw = readFileSync(path);
    let targetProfile;
    try {
      targetProfile = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new Error("The linked repository profile must contain valid JSON.");
    }
    if (!targetProfile || typeof targetProfile !== "object" || Array.isArray(targetProfile)) {
      throw new Error("The linked repository profile must be a JSON object.");
    }
    if (!permitsLocal(profile) || !permitsLocal(targetProfile)) {
      throw new Error("Both linked profiles must explicitly permit local validation and disallow production operations.");
    }
    const frontend = targetProfile.applications?.frontend;
    if (targetProfile.browserAutomation?.mode === "api" ||
        !frontend || typeof frontend.command !== "string" || !frontend.command.trim() ||
        typeof frontend.workingDirectory !== "string" ||
        !Number.isInteger(frontend.port) || frontend.port < 1 || frontend.port > 65535) {
      throw new Error("The linked repository must configure its own frontend command, directory and port.");
    }
    const directory = setupPath(target, frontend.workingDirectory);
    if (!lstatSync(directory).isDirectory()) {
      throw new Error("The linked frontend directory must exist inside its own repository.");
    }
    const url = localUrl(link.url);
    const health = localUrl(frontend.healthUrl);
    if (url.port !== String(frontend.port) || health.port !== url.port ||
        health.protocol !== url.protocol) {
      throw new Error("The linked URL must match the frontend port and health protocol in its owner's profile.");
    }
    const targetIdentity = lstatSync(target);
    const revision = createHash("sha256")
      .update(`${root}\0${sourceIdentity.dev}\0${sourceIdentity.ino}\0`)
      .update(JSON.stringify(profile)).update("\0").update(target)
      .update(`\0${targetIdentity.dev}\0${targetIdentity.ino}\0`)
      .update(`\0${info.dev}\0${info.ino}\0`).update(raw).digest("hex");
    return {
      id: link.id, repository: target, application: link.application,
      environment: link.environment, url: url.origin, healthUrl: health.href, revision
    };
  });
}
