---
name: fixlab-windows-background-probes
description: Diagnose brief Git windows during idle FixLab polling and keep background repository probes hidden on Windows.
---

# FixLab Windows background probes

## When to use

Use when Git console windows flash during idle dashboard/chat polling, or when
adding background repository probes to those paths. Also use for loopback
connection resets in same-process tests around Git work or dashboard restarts.

## Verified solution

The chat polls `/api/status` once per second by default. Repository inspection
prunes owned artifacts, which resolves the Git artifact root. Cache inspection
has a separate Git helper. Either helper can open a brief Windows console even
when no job or executor is running.

Keep `windowsHide: true` and `shell: false` on both background `spawnSync` helpers:

- [Artifact-root Git helper](../../../dashboard/intake.js): `runGit`, reached
  through `pruneArtifactDirectories` and `resolveArtifactRoot`.
- [Dashboard Git helper](../../../dashboard/server.js): `runGit`, used by
  `createCacheContext`; `/api/status` calls `inspectRepository`.
- [Chat polling](../../../dashboard/chat.js): `runChat`.

Preserve command arguments, output handling and existing ownership checks.
Do not disable polling or change the owned executor's containment behavior to
hide windows created by a different background helper.

## Same-process HTTP fixtures

Keep fixture requests separate from the runtime's global fetch pool and its
`/api/session` self-probes. Blocking Git work or restarting a server can expose
stale pooled sockets. The dashboard server suite's `jsonRequest` uses
`node:http` with `agent: false`, preserving real HTTP without retries. A
`Connection: close` header alone can still select an already pooled socket.

The socket-isolation regression verifies distinct fixture/probe connections,
GET/POST methods, JSON payloads, headers and status codes:

```powershell
node --test --test-name-pattern="dashboard JSON fixtures isolate|connected Copilot recovery reuses|shared dashboard jobs refresh develop|idle finalization retains" test\dashboard-server.test.js
```

Do not treat a separately passing rerun as proof that the full suite passed,
or increase retries, deadlines or concurrency to conceal a failure.

## Validation

Working directory: `.` from the FixLab repository root, containing `package.json`.
Run the existing regression in PowerShell:

```powershell
node --test --test-name-pattern="idle status polling and cache inspection hide their Git windows" test\dashboard-server.test.js
```

The [regression](../../../test/dashboard-server.test.js) performs real HTTP
status polling and cache inspection, checks native Git spawn options, and
verifies idle polling never starts an executor. Its builtin-module spy must be
restored in `finally`, including `syncBuiltinESMExports()`.

Run `npm run validate` for implementation changes. On Windows,
`pwsh -NoLogo -NoProfile -File scripts\validate.ps1` runs that same required gate
while temporarily preventing idle sleep.

## Pitfalls

An interactive executor's console settings do not cover every independent Git
probe. Inspect the actual polling path before changing process-launch code.
Do not hide intended interactive terminals, bypass permissions, or stop
unrelated Git processes.
