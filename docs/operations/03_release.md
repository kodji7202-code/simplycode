# Release Runbook

SimplyCode's public preview release workflow is `.github/workflows/release.yml`.
It is intentionally smaller than upstream's release train.

## What a release publishes

- Windows x64 desktop installer, blockmap, and `latest.yml` updater feed
- Self-contained CLI archives for Windows x64 and Linux x64, plus `SHA256SUMS`
- The `simplycode` npm launcher

macOS, Linux desktop, Windows ARM64, mobile apps, nightly automation, signing,
hosted web deployment, and package-manager publishing are not part of the preview
release pipeline yet.

## Cutting a release

1. Make sure CI is green on `main`.
2. Choose a plain semver version. The first public preview is `0.1.0`.
3. Run the **Release** workflow manually with that version, or push a matching
   `vX.Y.Z` tag.
4. The workflow builds the JavaScript bundle once, builds and smoke-tests the
   Linux x64 CLI archive, builds the Windows x64 CLI archive and desktop
   installer, verifies the Windows payload on a Windows runner, publishes the
   GitHub release, then publishes the npm launcher.
5. Confirm:
   - `gh release view vX.Y.Z -R kodji7202-code/simplycode`
   - `npm view simplycode@X.Y.Z version`
   - the release contains `latest.yml`, `SHA256SUMS`, the Windows installer,
     and both CLI archives.

## npm credentials

Until npm Trusted Publishing is configured for the existing package, the workflow
needs an `NPM_TOKEN` repository secret. Use a granular npm access token with
**Read and write (publish and stage)** permission, permission to create the
`simplycode` package, and **Bypass 2FA** enabled. Use a short expiration. After
the first successful publish, configure npm Trusted Publishing for
`.github/workflows/release.yml` and remove the token.

## Cloud configuration

SimplyCode does not operate a hosted relay. Release builds do not bake in
upstream T3 Connect identifiers. `.env.example` contains placeholders for a
self-hosted compatible relay only.

## Signing

Windows builds are unsigned in the preview and may trigger SmartScreen. Azure
Trusted Signing and Apple signing/notarization remain future work; do not publish
signed macOS or Windows builds from this workflow without restoring those jobs
and their validation.
