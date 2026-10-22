---
mode: agent
description: Validate the expected behavior in the running application.
---

Start only the applications required by the effective diff, using the commands,
ports, environments, and health URLs in the FixLab profile. Track every process
created and never stop an unrelated process. Run the repository-defined
Playwright journey on the developer or registered-runner machine. Capture
sanitized screenshots, API assertions, logs, cleanup, and the exact observable
result.

For `browserAutomation.mode: "api"`, use `APIRequestContext` without a frontend,
browser binary, screenshot or video. Enforce the profile's approved origins,
read-only methods and redirects before sending requests; browser interception
does not protect API requests. Require fresh API authentication when configured.
Preserve only sanitized status/schema assertion results and `FIXLAB_TEST`
evidence. Missing access or startup blocks the live gate; never replace it with
synthetic API success or retain credentials or sensitive response bodies.
