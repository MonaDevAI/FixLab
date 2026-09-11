# React and .NET example

Copy `repository-profile.json` to:

```text
.github/fixlab/repository-profile.json
```

Then update every path and command to match the application repository. Copy
`playwright.config.ts` only when the repository does not already own a
Playwright configuration.

Run:

```shell
fixlab init
fixlab setup-playwright
fixlab setup-playwright --yes
fixlab doctor
```

The example uses Microsoft Edge through Playwright's Chromium API. Remove the
`channel` setting when the repository intentionally uses bundled Chromium.
