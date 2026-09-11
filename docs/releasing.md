# Releasing FixLab

FixLab uses GitHub Actions for continuous integration and tagged releases.

## Repository settings

1. Protect `main` and require the `CI / test` check.
2. Enable GitHub Actions with read access to repository contents.
3. Create an `npm` environment and require the desired reviewers.
4. Configure npm trusted publishing for:
   - Repository: `MonaDevAI/FixLab`
   - Workflow: `.github/workflows/release.yml`
   - Environment: `npm`
5. Confirm that the npm organization owns the `@fixlab` scope.

Do not commit npm tokens. The release workflow requests an OpenID Connect token
and publishes with npm provenance.

## Create a release

1. Update `package.json`, `plugin.json`, and `CHANGELOG.md` to the same version.
2. Merge the release change to `main`.
3. Create and push the matching tag:

   ```shell
   git tag v0.3.0
   git push origin v0.3.0
   ```

The workflow verifies that the tag matches the package and plugin versions,
runs tests, validates the package contents, publishes `@fixlab/cli`, and
creates the GitHub release.
