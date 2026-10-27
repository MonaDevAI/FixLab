import { lstatSync } from "node:fs";
import { setupPath } from "./repository-setup.js";

export function apiAuthenticationConfiguration(repository, configuration, { requireHelper = true } = {}) {
  if (!configuration || !["consumer", "portal"].includes(configuration.role)) {
    throw new Error("API authentication must explicitly select a consumer or portal role.");
  }
  if (configuration.productionDatabaseReadOnly !== undefined &&
      typeof configuration.productionDatabaseReadOnly !== "boolean") {
    throw new Error("Production database reads require an explicit boolean opt-in.");
  }
  const url = new URL(configuration.url);
  if (url.protocol !== "https:" || !["localhost", "127.0.0.1"].includes(url.hostname) ||
      !url.port || url.username || url.password || url.search || url.hash) {
    throw new Error("Portal-backed API authentication requires an approved credential-free local HTTPS API URL.");
  }
  if (typeof configuration.scope !== "string" || configuration.scope.length > 512) {
    throw new Error("Provide the API's full approved scope, never a token.");
  }
  const scope = new URL(configuration.scope);
  if (!["api:", "https:"].includes(scope.protocol) || scope.username || scope.password ||
      scope.search || scope.hash || !scope.pathname || scope.pathname === "/" ||
      ["graph.microsoft.com", "management.azure.com"].includes(scope.hostname) ||
      /\s/u.test(configuration.scope)) {
    throw new Error("Provide the API's full approved scope, not an identity/management scope or credential.");
  }
  if (configuration.role === "portal" && requireHelper) {
    if (typeof configuration.sessionHelper !== "string" ||
        /(?:^|[/\\])(?:\.git|node_modules|\.auth|\.edge-profile|\.env(?:\.[^/\\]*)?)(?:[/\\]|$)/iu.test(configuration.sessionHelper)) {
      throw new Error("The API session helper must be source code, not credentials, browser state or an external dependency.");
    }
    const helper = setupPath(repository, configuration.sessionHelper);
    const info = lstatSync(helper);
    if (!info.isFile() || info.nlink !== 1 || info.size > 1048576 ||
        !/\.(?:mjs|cjs|js)$/u.test(helper)) {
      throw new Error("The API session helper must be a contained, unlinked repository-owned JavaScript module.");
    }
  }
  return { ...configuration, url: url.href };
}
