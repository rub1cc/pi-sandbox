# Releasing

Each repository publishes independently. A stable `vX.Y.Z` Git tag triggers
`.github/workflows/publish.yml`, which verifies the tag against `package.json`
and publishes that version to npm using OIDC. It does not bump versions itself
or run the host-dependent test suite. No npm token secret is needed in GitHub.

## One-time npm setup

1. Commit and push the workflow and package repository metadata to `main`.
2. If the package has never been published, publish its first version locally:

   ```sh
   npm login
   npm install --omit=dev --ignore-scripts --legacy-peer-deps --package-lock=false
   npm publish --access public
   ```

3. On npmjs.com, open the package's Settings, then Trusted Publisher. Select
   GitHub Actions, owner `rub1cc`, this repository's name (without the owner),
   and workflow filename `publish.yml` (not the full path). Leave the environment
   blank and enable direct `npm publish` permission.
4. Trigger a release within two days of creating the trusted publisher so the
   new configuration does not expire. Use a new version if the first version
   was already published manually.

Configure each package separately. GitHub-hosted runners provide the publishing
identity; `NODE_AUTH_TOKEN` and `NPM_TOKEN` secrets are not required.

## Release a new version

Run tests in your normal Pi development environment, commit all changes, and
start with a clean working tree on `main`:

```sh
npm test
npm version patch
git push --follow-tags origin main
```

`npm version patch` updates `package.json` (and a tracked npm lockfile, if any),
creates a version commit, and creates its matching annotated Git tag. Use
`npm version minor` or `npm version major` instead for larger releases. There is
no need to create a separate tag. Prerelease tags are intentionally rejected.

Watch the repository's Actions tab for the publish result. npm versions are
immutable: never move a published tag or reuse a published version. If only the
workflow failed before publishing, rerun that failed workflow after fixing the
cause, or create a new version containing the fix.

## Shared dependency release order

When releasing changes across the shared packages, publish in this order:

1. `@rub1cc/pi-apply-patch`
2. `@rub1cc/pi-renderer`
3. `@rub1cc/pi-sandbox`

Wait for each package to be available on npm before releasing its dependent.
Update and commit the dependent's exact dependency pin before running
`npm version`. That command changes only this package's version, not its
dependency pins. The workflow installs the pinned runtime dependencies before
packing, including the declared bundled dependencies. Adaptive-scroll and
statusline can be released independently.

See https://docs.npmjs.com/trusted-publishers/ for trusted publishing details.
