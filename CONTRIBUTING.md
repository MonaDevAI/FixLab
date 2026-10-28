# Contributing

1. Open an issue describing the change and expected behavior.
2. Keep product-specific configuration in examples or target repositories.
3. Do not add credentials, private endpoints, customer data, or authentication
   artifacts.
4. Add or update tests for behavioral changes.
5. Update the directly related documentation.
6. Use a pull request and obtain code-owner review.

Changes to runner execution, authentication, process termination, release
workflows, or secret handling require security review.

## Local completion gate

Use Node.js 20.19+ in the 20.x line or 22.12+, install from the committed lock file, and run the same
deterministic checks used by pull-request validation:

```shell
npm ci
npm run validate
```

Optional pre-commit integration is available through
`.pre-commit-config.yaml`. Machine-readable test and documentation-drift
reports are uploaded by CI from `artifacts/`.

### Platform setup

The setup scripts require the Node.js 20.x line pinned by `.node-version`;
use 20.19+ within that line. Direct lock-file installation remains available
on the other supported Node.js versions.

On Linux/macOS, the repository setup script installs development dependencies:

```shell
./scripts/setup.sh
npm run validate
```

On Windows:

```powershell
pwsh -File scripts/setup.ps1
pwsh -File scripts\validate.ps1
```

The Windows runner executes the same complete `npm run validate` gate while
temporarily preventing idle system/display sleep. It restores the previous
execution state on exit, preserves the gate's exit code, and does not change
power plans, override manual sleep, or skip checks.

Local and CI unit suites run at most two test files concurrently to bound
overlapping process/compiler/browser fixtures. Individual test concurrency
and deadlines are unchanged. CI containment never converts a passing retry
after an initial failure into a successful aggregate.

### Installed-package browser acceptance

To run browser acceptance against an installed package rather than this checkout:

```powershell
$env:FIXLAB_TEST_PACKAGE_ROOT = 'C:\path\to\node_modules\@fixlab\cli'
npm run test:e2e
Remove-Item Env:FIXLAB_TEST_PACKAGE_ROOT
```

### Run the plugin from source

```shell
agency copilot --plugin-dir . --agent fixlab:fixlab
copilot --plugin-dir . --agent fixlab:fixlab
```
