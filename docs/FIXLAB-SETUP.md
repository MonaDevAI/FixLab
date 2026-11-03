# Easy FixLab setup with Copilot

Choose the one-prompt path for the fastest guided setup. Use this Markdown guide
for reusable, reviewable repository instructions. In either path, review the
proposed plan and approve each setup change before it is applied.

## Option 1: paste one prompt

Open Copilot in the repository you want to onboard and paste:

```text
Install or reuse FixLab, register its MCP server, and onboard this repository
with --runtime copilot. Review the real repository profile and setup plan
with me before applying changes. Prepare Playwright and genuine live
authentication when required by the profile, run Doctor, and start or reuse
the matching dashboard. Ask before changes, preserve my application code,
and do not start a job.
```

You still approve reviewed setup actions and complete sign-in/MFA yourself.

## Option 2: give Copilot this Markdown file

1. Copy this file into the target repository's root. Do not overwrite an existing
   setup guide without reviewing it.
2. Open Copilot in that checkout.
3. Enter:

```text
Read @FIXLAB-SETUP.md and set up FixLab for this repository.
Show the plan and ask before applying changes.
```

If the file is elsewhere, attach it or give Copilot its actual path instead.
This document is an instruction guide, not an automatic installer or permission
grant. The steps below are for Copilot to follow after the user's setup request.

## If the guide is unavailable

The file is optional. Follow FixLab's
[first-installation steps](https://github.com/MonaDevAI/FixLab/blob/main/installation.md)
or [detailed manual setup](https://github.com/MonaDevAI/FixLab/blob/main/docs/installation.md#recommended-path-install-then-run).
Do not substitute an unrelated application's installation guide or repeatedly
request a missing attachment. Keep the same review and authentication safeguards.

## Instructions for Copilot

### 1. Inspect before changing anything

- Read the checkout's contributor instructions and inspect `git status --short`.
- Confirm the repository path, runtime, application ports, and dashboard port.
- Preserve existing edits, branches, dependency junctions, and running services.
- Check Git, supported Node.js/npm, PowerShell on Windows, and the authenticated
  Copilot runtime. Explain missing prerequisites before installing anything.
- Reuse a compatible Node installation and respect the application's version
  pin; do not replace a working global runtime merely to match FixLab's test pin.

### 2. Install or reuse FixLab

Check `Get-Command fixlab` and `fixlab --help`. Reuse an approved installed version.
If installation is needed, show and request approval for:

```powershell
npm install --global github:MonaDevAI/FixLab
fixlab --help
```

Do not disable TLS verification or change private-feed credentials. If enterprise
policy restricts public GitHub access, use only an organization-approved source
as described in the detailed installation guide.

### 3. Connect Copilot through MCP

Inspect an existing registration with `copilot mcp get fixlab`; reuse it if it
points to the correct installation. Otherwise show and review:

```powershell
$FixLabMcp = Join-Path (npm root --global) '@fixlab\cli\mcp\server.js'
if (-not (Test-Path -LiteralPath $FixLabMcp -PathType Leaf)) {
    throw 'FixLab MCP server is missing; verify the approved installation.'
}
copilot mcp add fixlab -- node $FixLabMcp
copilot mcp get fixlab
```

Check the connection through `/mcp` in Copilot; reopen the session if necessary.
Registration does not start a dashboard, grant tool permissions, or establish
application authentication.

### 4. Onboard the actual checkout

Set `$Repo` to the confirmed repository path, then run:

```powershell
fixlab onboard $Repo --runtime copilot
```

Review `.github\fixlab\repository-profile.json` using the real component paths,
startup commands, health URLs, tests, validation gates, browser tooling, and
authentication helpers. Show proposed changes and the onboarding plan.

After review and explicit approval, apply only that plan:

```powershell
fixlab onboard $Repo --yes --runtime copilot
```

Do not treat example profile paths as real or remove required validation gates.

### 5. Prepare required Playwright and live authentication

Follow the profile's actual browser/API/unit-only requirements. Do not add a
browser to an API-only job or disable required live coverage to pass readiness.

Review the browser-tool installation plan when applicable:

```powershell
fixlab setup-playwright $Repo
```

If tools are missing, apply with `--yes` only after approval. Reuse compatible
installed tools and do not install through unreviewed shared dependency junctions.

Review `browserAutomation.workingDirectory` and
`browserAutomation.authentication`, including its authentication command, proof
command, and tracked status paths. Use repository-owned helpers.

```powershell
fixlab authenticate $Repo
# Only after reviewing and approving the authentication plan:
fixlab authenticate $Repo --yes
```

The user completes genuine application sign-in/MFA themselves. Keep tokens and
browser state local and ignored by Git. Never fabricate a readiness marker,
copy another checkout's authentication state, or treat `az login` as frontend
sign-in. Report readiness only when the required genuine live proof succeeds.

### 6. Check readiness and open the dashboard

```powershell
fixlab doctor $Repo --runtime copilot
```

Explain remaining requirements. When readiness and approvals permit, start or
reuse the exact checkout's dashboard with the agreed `$DashboardPort`:

```powershell
fixlab dashboard $Repo --port $DashboardPort --no-open --runtime copilot
# Alternatively:
fixlab chat $Repo --port $DashboardPort --runtime copilot
```

Verify repository, port, instance, and current job through
`fixlab_dashboard_status` when the MCP bridge is connected. Ask the user for
missing decisions or required approvals instead of guessing.

Do not start a bug-fixing job, change application UI, commit, push, create a pull
request, approve unsafe data access, or stop unrelated resources as part of setup.
Finish with actual installation, profile, browser-tool, authentication, and
dashboard status, including unresolved requirements.
