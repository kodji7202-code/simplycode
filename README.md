# SimplyCode

<p align="center"><img src="assets/brand/simplycode-logo.png" width="160" alt="SimplyCode logo"></p>

SimplyCode is an **unofficial community fork** of [T3 Code](https://github.com/pingdotgg/t3code), a minimal open-source GUI for coding agents.

> **Disclaimer:** SimplyCode is not affiliated with, endorsed by, or supported by T3 Tools, Inc.
> "T3 Code" is a trademark of T3 Tools, Inc. This fork is based on the MIT-licensed
> T3 Code source code only — it ships no T3 Code branding, wordmark, or icons.

## Public preview install

The first public preview ships a Windows x64 desktop installer and the `simplycode`
CLI for Windows x64 and Linux x64. macOS, signed installers, and the mobile apps are
not part of this preview yet.

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/kodji7202-code/simplycode/main/scripts/install.ps1 | iex
```

Linux or npm (Windows x64 / Linux x64):

```bash
curl -fsSL https://raw.githubusercontent.com/kodji7202-code/simplycode/main/scripts/install.sh | sh
npm install -g simplycode
```

The Windows installer is currently unsigned, so SmartScreen may warn before running it.
Download desktop installers and checksums from [GitHub Releases](https://github.com/kodji7202-code/simplycode/releases).

## Bots

Bots are saved, reusable agent profiles: a name, a robot avatar, an optional
role, a provider and model with a thinking level, an approval mode, and
project/workspace defaults. Bots can be pinned and enabled or disabled.

The app has a dedicated Bots section next to Threads: a bot sidebar with search
and pinned bots, an overview of all bots, per-bot conversation lists, a
run-now composer, and an inline profile panel for editing. Scheduled tasks can
be owned by a bot, and every bot run is an ordinary thread.

Planned: delegation between bots, per-bot memory and skills, and review
pipelines.

## Differences from upstream

- App name, wordmark, and icons are SimplyCode's.
- The CLI binary is `simplycode` (upstream's is `t3`); the default home directory
  is `~/.simplycode` and the default server port is 4773, so a fork install never
  collides with an official T3 Code install.
- Product telemetry and analytics are removed entirely; see [Privacy](#privacy).
- There is no hosted web app; desktop/mobile deep links use the `simplycode://` scheme.

## Privacy

**This fork sends no telemetry.**

**Acest fork nu trimite telemetrie.**

SimplyCode ships no product analytics, no ingest endpoint, and no hosted relay.
Local diagnostics — trace files, the resource monitor, the Diagnostics page —
never leave your machine. The only external requests that remain are:

- **Agent CLI and model list updates.** SimplyCode checks npm, downloads.claude.ai and api.meta.ai for new versions of the agent CLIs, and refreshes its model list from this repository on GitHub. Turn this off in Settings with **Provider update checks**.
- **SimplyCode updates.** The app looks up the latest SimplyCode release on npm and GitHub.
- **Model prices for Usage.** The public LiteLLM price list on GitHub, fetched when the Usage page needs rates.
- **Things you set up.** Telegram notifications, OpenTelemetry export to your own endpoint, a relay you link, source control and issue tracker integrations, and MCP servers send data only where you point them.
- **The agents themselves.** Codex, Claude Code, Devin and the other CLIs talk to their own vendors under their own privacy terms.

## Build

See [docs/user/install.md](docs/user/install.md) for install options and
[docs/operations/00_development.md](docs/operations/00_development.md) for the dev
setup (`vp i`, `npm run dev`).

## Merging upstream

`git merge upstream/main`, resolve conflicts by taking upstream on brand-edited
lines, then run `node scripts/rebrand.ts` — it is deterministic and idempotent.
