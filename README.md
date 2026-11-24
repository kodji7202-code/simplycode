# SimplyCode

SimplyCode is an **unofficial community fork** of [T3 Code](https://github.com/pingdotgg/t3code), a minimal open-source GUI for coding agents.

> **Disclaimer:** SimplyCode is not affiliated with, endorsed by, or supported by T3 Tools, Inc.
> "T3 Code" is a trademark of T3 Tools, Inc. This fork is based on the MIT-licensed
> T3 Code source code only — it ships no T3 Code branding, wordmark, or icons.

## Differences from upstream

- App name, wordmark, and icons are SimplyCode's.
- The CLI binary is `simplycode` (upstream's is `t3`); the default home directory
  is `~/.simplycode` and the default server port is 4773, so a fork install never
  collides with an official T3 Code install.
- Product telemetry is off unless you configure `T3CODE_POSTHOG_KEY` and
  `T3CODE_POSTHOG_HOST`; the fork ships no T3-owned ingest endpoint.
- There is no hosted web app; desktop/mobile deep links use the `simplycode://` scheme.

## Build

See [docs/user/install.md](docs/user/install.md) for install options and
[docs/operations/00_development.md](docs/operations/00_development.md) for the dev
setup (`vp i`, `npm run dev`).

## Merging upstream

`git merge upstream/main`, resolve conflicts by taking upstream on brand-edited
lines, then run `node scripts/rebrand.ts` — it is deterministic and idempotent.
