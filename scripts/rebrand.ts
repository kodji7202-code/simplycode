/**
 * SimplyCode rebrand codemod: deterministic, idempotent, data-driven.
 * Run after every upstream merge: `node scripts/rebrand.ts` (`--no-i18n`
 * when `vp` is unavailable). Lines marked `rebrand-keep` are untouched.
 */

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const REPO_ROOT = NodePath.resolve(NodeURL.fileURLToPath(new URL(".", import.meta.url)), "..");
const KEEP_MARKER = "rebrand-keep";
const NO_I18N = process.argv.includes("--no-i18n");

const BRAND = "SimplyCode";
const FORK_REPO = "kodji7202-code/simplycode";
const FORK_REPO_URL = `https://github.com/${FORK_REPO}`;
const FORK_RAW_URL = `https://raw.githubusercontent.com/${FORK_REPO}/main`;
const APP_ID = "io.github.kodji7202code.simplycode";
// RFC 6761 `.invalid`: the fork runs no hosted surface; these never resolve.
const HOSTED_APP_HOST = "hosted.simplycode.invalid";
const HOSTED_APP_URL = `https://${HOSTED_APP_HOST}`;

// Paths never touched by any rule. Prefixes match repo-relative POSIX paths.

const EXCLUDED_PREFIXES = [
  ".git/",
  ".repos/",
  ".task-cache/",
  "node_modules/",
  "apps/marketing/",
  "apps/mobile/ios/",
  "apps/mobile/android/",
  "infra/",
  "docs/internals/",
  "docs/operations/",
  "evals/",
  "skills/",
  ".agents/",
  ".github/",
  "native/",
  "patches/",
  "oxlint-plugin-t3code/",
  "third-party-licenses/",
  "scripts/testkit/fixtures/",
];

const EXCLUDED_FILES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "LICENSE", // appended by a dedicated rule below
  "README.md",
  "TRADEMARK.md",
  "UPSTREAM.md",
  // Native-module docs carry upstream attribution verbatim (vendored branch
  // refs, "T3 Code has substantially modified ..." history).
  "apps/mobile/modules/t3-source-text/UPSTREAM.md",
  "apps/mobile/modules/t3-review-diff/tests/android/README.md",
  "apps/mobile/modules/t3-terminal/README.md",
  "apps/mobile/modules/t3-terminal/THIRD_PARTY_NOTICES.md",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "scripts/rebrand.ts",
  "scripts/generate-simplycode-icons.ts",
]);

const BINARY_SUFFIXES = [
  ".png",
  ".ico",
  ".icns",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".mp4",
  ".mov",
  ".webm",
  ".mp3",
  ".wav",
  ".exe",
  ".dll",
  ".node",
  ".wasm",
  ".zip",
  ".gz",
  ".tgz",
  ".tar",
  ".dmg",
  ".jar",
  ".vsix",
  ".pdf",
  ".bin",
  ".dat",
  ".sqlite",
  ".sqlite3",
  ".db",
  ".pack",
  ".idx",
  ".bmp",
  ".appimage",
  ".aab",
  ".apk",
  ".ipa",
  ".dylib",
  ".so",
  ".a",
  ".lib",
  ".pdb",
  ".keystore",
  ".jks",
  ".p12",
  ".der",
  ".ndjson",
  ".snap",
];

// Global text rules. Ordered; each rule replaces every occurrence on the line.

const TEXT_RULES: ReadonlyArray<readonly [string, string]> = [
  ["T3 Code (Beta)", BRAND],
  ["T3 Code (Nightly)", `${BRAND} (Nightly)`],
  ["T3 Code Dev", `${BRAND} Dev`],
  ["T3 Code Preview", `${BRAND} Preview`],
  ["T3-Code", BRAND],
  ["T3 Code", BRAND],
  // "T3 thread(s)" stays: it names the t3_thread_* tool calls in model-facing
  // and eval-covered sentences.
  ["T3 desktop", `${BRAND} desktop`],
  ["com.t3tools.t3code", APP_ID],
  ["com.t3tools.T3Code", APP_ID],
  ["T3CodeDev", `${BRAND}Dev`],
  ["T3Code", BRAND],
  // Internal identifiers that stay upstream-shaped for merge friendliness.
  [`${BRAND}PublicConfig`, "T3CodePublicConfig"],
  // Default home directory: ~/.t3 -> ~/.simplycode (env var names stay T3CODE_*).
  ["~/.t3", "~/.simplycode"],
  ["/.t3/", "/.simplycode/"],
  ['".t3"', '".simplycode"'],
  ["'.t3'", "'.simplycode'"],
  // Install entry points and any remaining t3.codes links -> this repository.
  ["https://t3.codes/install.sh", `${FORK_RAW_URL}/scripts/install.sh`],
  ["https://t3.codes/install.ps1", `${FORK_RAW_URL}/scripts/install.ps1`],
  ["https://t3.codes/download", `${FORK_REPO_URL}/releases`],
  ["https://t3.codes", FORK_REPO_URL],
  // Issue tracker points at the fork (covers /issues/new?template=... too);
  // other pingdotgg/t3code cites (PRs, commits, attribution) stay upstream.
  ["github.com/pingdotgg/t3code/issues", `github.com/${FORK_REPO}/issues`],
  // Repairs trees corrupted by an earlier rule that dropped the github.com host.
  [`https://${FORK_REPO}/issues`, `${FORK_REPO_URL}/issues`],
  ["noreply@t3.codes", "noreply@simplycode.invalid"],
  // The fork has no App Store listing; docs point at fork releases instead.
  [
    "https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824",
    `${FORK_REPO_URL}/releases`,
  ],
  // Repairs trees where an earlier rule left a doubled scheme.
  ["https://https://", "https://"],
];

const REGEX_RULES: ReadonlyArray<{ re: RegExp; to: string; except?: string[] }> = [
  // Bare `t3` (CLI, bin name, log tags). Lookarounds keep `t3_*` tools, `t3code`, `t3.json`,
  // `bin.t3` and `t3.micro`. `except` files use `t3` as a binding whose `t3.foo` accesses are
  // protected, so renaming it would leave them dangling.
  {
    re: /(?<![\w$./-])t3(?![\w./-])/g,
    to: "simplycode",
    except: [
      "scripts/scenarios/",
      "packages/shared/src/otelEnvironment.ts",
      // Kotlin/Swift identifiers (expo.modules.t3*, t3_* resources) stay
      // upstream-shaped; only string literals are rebranded by scoped rules.
      "apps/mobile/modules/",
    ],
  },
  // Upstream repo coordinates -> fork, except links that cite upstream PRs,
  // issues, commits, or workflow runs (those keep pointing at pingdotgg).
  {
    re: /pingdotgg\/t3code(?!\/(?:pull|issues?|commits?|compare|actions|workflows)\b)/g,
    to: FORK_REPO,
    // Upstream citations inside vendored native modules stay upstream.
    except: ["apps/mobile/modules/"],
  },
  // The executable inside runtime/versions/<v>/ keeps the archive-internal
  // name t3 (the user-facing launcher is `simplycode`). Covers both literal
  // `versions/<v>/simplycode` and `path.join(..., "versions", <v>, "simplycode")`.
  {
    re: /versions([\\/][\w.${}-]+)[\\/]simplycode(?=["'`\s)\\/]|$)/g,
    to: "versions$1/t3",
  },
  {
    re: /(versionsDir|"versions"|"runtime\/versions")([^()\n]{0,80}?),\s*"simplycode"/g,
    to: '$1$2, "t3" /* rebrand-keep */',
  },
];

// Scoped literal rules applied only under the listed directory prefixes.

const SCOPED_TEXT_RULES: ReadonlyArray<{
  prefixes: ReadonlyArray<string>;
  rules: ReadonlyArray<readonly [string, string]>;
}> = [
  {
    // Custom URL schemes and deep links: t3code:// -> simplycode:// etc.
    // `t3code:` storage keys, DB names, user-agents, and manifest keys are not
    // spelled this way in these trees and are intentionally left alone.
    prefixes: [
      "apps/desktop/",
      "apps/mobile/",
      "apps/server/src/",
      "apps/web/src/",
      "packages/shared/src/",
      "packages/contracts/src/",
      "scripts/",
      "packaging/",
      "docs/user/",
    ],
    rules: [
      ["t3code-dev://", "simplycode-dev://"],
      ["t3code-preview://", "simplycode-preview://"],
      ["t3code://", "simplycode://"],
      ['"t3code-dev:"', '"simplycode-dev:"'],
      ['"t3code-preview:"', '"simplycode-preview:"'],
      ['"t3code:"', '"simplycode:"'],
      ['"t3code-dev"', '"simplycode-dev"'],
      ['"t3code-preview"', '"simplycode-preview"'],
      ["nightly.app.t3.codes", `nightly.${HOSTED_APP_HOST}`],
      ["latest.app.t3.codes", `latest.${HOSTED_APP_HOST}`],
      ["app.t3.codes", HOSTED_APP_HOST],
    ],
  },
  {
    // Quoted bare `t3code` / `t3.cmd` where they name a scheme, binary, shim,
    // or desktop-entry asset. Excludes packages/* (storage keys, manifest
    // fields, user-agents keep `t3code`).
    prefixes: ["apps/desktop/", "apps/mobile/", "apps/server/src/", "scripts/", "packaging/"],
    rules: [
      ['"t3code"', '"simplycode"'],
      ['"t3.cmd"', '"simplycode.cmd"'],
    ],
  },
  {
    // Effect service keys follow the package name (deterministicKeys); the
    // `>("`/`()("` anchors keep persisted git-ref namespaces like refs/t3/
    // and Symbol()/test-fixture strings untouched.
    prefixes: ["apps/server/src/"],
    rules: [
      ['>("t3/', '>("simplycode/'],
      ['()("t3/', '()("simplycode/'],
      // Multi-line calls: the key sits alone on its own line (whitespace then
      // quote), which only happens for these declarations in this tree.
      ['  "t3/', '  "simplycode/'],
    ],
  },
  {
    // Service and install identities: the fork's units, tasks, launchers, and
    // npm package never collide with or manage an official T3 Code install.
    prefixes: ["apps/server/src/", "docs/user/", "scripts/"],
    rules: [
      ["t3code.service", "simplycode.service"],
      ["t3code-${", "simplycode-${"],
      ["t3code-<", "simplycode-<"],
      // Scheduled-task names, task XML files, and internal prefixes follow
      // the service name so the fork never manages upstream's service.
      ["t3code-", "simplycode-"],
      [".local/bin/t3", ".local/bin/simplycode"],
      ["lib/node_modules/t3", "lib/node_modules/simplycode"],
      // `bin/` holds the user-facing launcher (simplycode); the archive exe
      // inside runtime/versions/<v>/ stays t3 and is protected by the slash.
      ["bin/t3", "bin/simplycode"],
      ["registry.npmjs.org/t3/", "registry.npmjs.org/simplycode/"],
      ["npx t3", "npx simplycode"],
      ["A t3.cmd cannot", "A simplycode.cmd cannot"],
      ["shadow-dir/t3", "shadow-dir/simplycode"],
      ["shadow-file/t3", "shadow-file/simplycode"],
    ],
  },
  {
    prefixes: ["scripts/"],
    rules: [
      ["t3.mjs", "simplycode.mjs"],
      ["t3.tgz", "simplycode.tgz"],
      ['"t3code-bin"', '"simplycode-bin"'],
      ['"t3code-nightly-bin"', '"simplycode-nightly-bin"'],
    ],
  },
  {
    // AUR packaging republishes the fork's own artifacts.
    prefixes: ["packaging/"],
    rules: [
      ["t3code", "simplycode"],
      ["T3-Code", "SimplyCode"],
    ],
  },
  {
    // User docs run on the new default port and have no hosted app.
    prefixes: ["docs/user/"],
    rules: [
      ["3773", "4773"],
      ["13773", "14773"],
      ["5733", "6733"],
    ],
  },
];

// Anchored per-file edits for changes text rules cannot express safely.
// Each {find, replace} pair rewrites the whole file. On a rerun a rule whose
// `find` is absent is a no-op; when neither side is present it is reported
// as stale so the table can be pruned after upstream changes.

const FILE_EDITS: ReadonlyArray<{
  file: string;
  edits: ReadonlyArray<readonly [find: string, replace: string]>;
}> = [
  {
    file: "apps/server/src/config.ts",
    edits: [["export const DEFAULT_PORT = 3773;", "export const DEFAULT_PORT = 4773;"]],
  },
  {
    file: "apps/desktop/src/app/DesktopApp.ts",
    edits: [
      ["const DEFAULT_DESKTOP_BACKEND_PORT = 3773;", "const DEFAULT_DESKTOP_BACKEND_PORT = 4773;"],
    ],
  },
  {
    file: "packages/ssh/src/tunnel.ts",
    edits: [["const DEFAULT_REMOTE_PORT = 3773;", "const DEFAULT_REMOTE_PORT = 4773;"]],
  },
  {
    file: "scripts/dev-runner.ts",
    edits: [
      ["const BASE_SERVER_PORT = 13773;", "const BASE_SERVER_PORT = 14773;"],
      ["const BASE_WEB_PORT = 5733;", "const BASE_WEB_PORT = 6733;"],
    ],
  },
  {
    file: "scripts/dev-runner.test.ts",
    edits: [
      ["13773", "14773"],
      ["13774", "14774"],
      ["5733", "6733"],
      ["5734", "6734"],
      ["6566", "7566"],
      // BASE_WEB_PORT is 6733 for the fork; the only fetch-blocked port it can
      // reach is 10080.
      [
        "// 6733 + 833 = 7566, which browsers block as sane-port.",
        "// 6733 + 3347 = 10080, which browsers block.",
      ],
      [
        "startOffset: 833,\n          requireServerPort: true,\n          requireWebPort: true,",
        "startOffset: 3347,\n          requireServerPort: true,\n          requireWebPort: true,",
      ],
      ["assert.equal(offset, 834);", "assert.equal(offset, 3348);"],
      ['{ port: 14_607, role: "server" }', '{ port: 18_121, role: "server" }'],
      ['{ port: 6567, role: "web" }', '{ port: 10_081, role: "web" }'],
      ['{ port: 13_773, role: "server" }', '{ port: 14_773, role: "server" }'],
    ],
  },
  {
    file: "scripts/scenarios/start-app.ts",
    edits: [["5733", "6733"]],
  },
  {
    file: "apps/web/vite.config.ts",
    edits: [["?? 5733", "?? 6733"]],
  },
  {
    // Fork default: telemetry stays off unless the operator configures a
    // PostHog key and host. Empty defaults keep `enabled` harmless.
    file: "apps/server/src/telemetry/AnalyticsService.ts",
    edits: [
      [
        'Config.withDefault("phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m")',
        'Config.withDefault("")',
      ],
      ['Config.withDefault("https://ingest.t3.codes")', 'Config.withDefault("")'],
      [
        "if (!telemetryConfig.enabled || !policyAllows) return Effect.succeed(false);",
        "if (\n      !telemetryConfig.enabled ||\n      !policyAllows ||\n      telemetryConfig.posthogKey.length === 0 ||\n      telemetryConfig.posthogHost.length === 0\n    )\n      return Effect.succeed(false);",
      ],
    ],
  },
  {
    file: "apps/mobile/app.config.ts",
    edits: [
      [
        `const variant = VARIANT_CONFIG[APP_VARIANT];\n// Copied thread links open the app. app.t3.codes/.well-known lists every variant's identifiers.\nconst HOSTED_APP_HOST = "app.t3.codes";`,
        `const variant = VARIANT_CONFIG[APP_VARIANT];\n// The fork ships no hosted web app, so no applinks host is declared.\nconst easProjectId = repoEnv.SIMPLYCODE_EAS_PROJECT_ID?.trim() || undefined;\nconst easOwner = repoEnv.SIMPLYCODE_EAS_OWNER?.trim() || undefined;\nconst clerkRpDomain = repoEnv.SIMPLYCODE_CLERK_RP_DOMAIN?.trim() || undefined;`,
      ],
      // Same declaration for trees that already ran an earlier codemod pass
      // (find disappears once clerkRpDomain is inserted, so reruns no-op).
      [
        "const easOwner = repoEnv.SIMPLYCODE_EAS_OWNER?.trim() || undefined;\nconst iosBundleIdentifier = isIosPersonalTeamBuild",
        "const easOwner = repoEnv.SIMPLYCODE_EAS_OWNER?.trim() || undefined;\nconst clerkRpDomain = repoEnv.SIMPLYCODE_CLERK_RP_DOMAIN?.trim() || undefined;\nconst iosBundleIdentifier = isIosPersonalTeamBuild",
      ],
      // The fork has no Clerk relying party; passkeys/webcredentials activate
      // only when SIMPLYCODE_CLERK_RP_DOMAIN is set at build time.
      ['    relyingParty: "clerk.t3.codes",\n', ""],
      [
        "    associatedDomains: [\n      `applinks:${variant.relyingParty}`,\n      `webcredentials:${variant.relyingParty}`,\n    ],",
        "    ...(clerkRpDomain\n      ? {\n          associatedDomains: [`applinks:${clerkRpDomain}`, `webcredentials:${clerkRpDomain}`],\n        }\n      : {}),",
      ],
      ['slug: "t3-code"', 'slug: "simplycode"'],
      [
        '    url: "https://u.expo.dev/d763fcb8-d37c-41ea-a773-b54a0ab4a454",',
        "    ...(easProjectId ? { url: `https://u.expo.dev/${easProjectId}` } : {}),",
      ],
      [
        '    appleTeamId: "ARK85ZXQ4Z",',
        "    ...(repoEnv.SIMPLYCODE_APPLE_TEAM_ID ? { appleTeamId: repoEnv.SIMPLYCODE_APPLE_TEAM_ID } : {}),",
      ],
      ["      `applinks:${HOSTED_APP_HOST}`,\n", ""],
      [
        `    intentFilters: [
      {
        action: "VIEW",
        autoVerify: true,
        data: [{ scheme: "https", host: HOSTED_APP_HOST, pathPrefix: "/threads/" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ],`,
        "    intentFilters: [],",
      ],
      [
        '      projectId: "d763fcb8-d37c-41ea-a773-b54a0ab4a454",',
        "      ...(easProjectId ? { projectId: easProjectId } : {}),",
      ],
      ['  owner: "pingdotgg",', "  ...(easOwner ? { owner: easOwner } : {}),"],
      // Mobile relay traces default off: without a configured OTLP endpoint the
      // app must not post to T3's Axiom.
      [
        'tracesUrl: repoEnv.EXPO_PUBLIC_OTLP_TRACES_URL ?? "https://api.axiom.co/v1/traces"',
        "tracesUrl: repoEnv.EXPO_PUBLIC_OTLP_TRACES_URL ?? null",
      ],
    ],
  },
  {
    file: "apps/mobile/eas.json",
    edits: [
      [
        `      "ios": {
        "ascAppId": "6787819824"
      },`,
        `      "ios": {},`,
      ],
    ],
  },
  {
    // The mobile attribution value is the internal union member "t3code"
    // (client-runtime and web keep it); the display label stays rebranded.
    file: "apps/mobile/src/features/threads/ThreadFeed.tsx",
    edits: [
      [
        '{presentation.attribution === "t3code" ? (',
        '{presentation.attribution === "t3code" /* rebrand-keep */ ? (',
      ],
      [
        '{presentation.attribution === "simplycode" ? (',
        '{presentation.attribution === "t3code" /* rebrand-keep */ ? (',
      ],
    ],
  },
  {
    file: "apps/mobile/src/features/threads/ThreadQueueControl.tsx",
    edits: [
      [': attribution === "t3code"\n', ': attribution === "t3code" /* rebrand-keep */\n'],
      [': attribution === "simplycode"\n', ': attribution === "t3code" /* rebrand-keep */\n'],
    ],
  },
  {
    // The executable inside runtime/versions/<v>/ keeps the archive-internal
    // name (t3/t3.exe); only the user-facing launcher is `simplycode`.
    file: "apps/server/src/cloud/pinnedRuntime.ts",
    edits: [
      ['? "t3.exe" : "t3"),', '? "t3.exe" : "t3" /* rebrand-keep */),'],
      ['? "t3.exe" : "simplycode"),', '? "t3.exe" : "t3" /* rebrand-keep */),'],
      // isVersionExecutable matches the archive exe name inside versions dirs.
      [
        "[\\\\/]t3(?:\\.exe)?$/i.test(relative);\n",
        "[\\\\/]t3(?:\\.exe)?$/i.test(relative); // rebrand-keep\n",
      ],
      [
        "[\\\\/]simplycode(?:\\.exe)?$/i.test(relative);\n",
        "[\\\\/]t3(?:\\.exe)?$/i.test(relative); // rebrand-keep\n",
      ],
    ],
  },
  {
    file: "apps/server/src/serviceLauncher.ts",
    edits: [
      // EOL-anchored so the formatter-moved `; /* rebrand-keep */` form does
      // not match again (marker lands after the semicolon post-format).
      ['? "t3.exe" : "t3";\n', '? "t3.exe" : "t3"; /* rebrand-keep */\n'],
      ['? "t3.exe" : "simplycode";', '? "t3.exe" : "t3"; /* rebrand-keep */'],
      // Repairs a tree where the substring find re-fired on the marked line.
      [
        '? "t3.exe" : "t3" /* rebrand-keep */; /* rebrand-keep */',
        '? "t3.exe" : "t3"; /* rebrand-keep */',
      ],
      // The repoint matchers look for the archive exe inside versions dirs.
      [
        '  /^(ExecStart=.*?[\\\\/]runtime[\\\\/]versions[\\\\/])([^\\\\/\\s"]+)([\\\\/]t3)(?=["\\s])/m,\n  /(<string>[^<]*?[\\\\/]runtime[\\\\/]versions[\\\\/])([^\\\\/<]+)([\\\\/]t3<\\/string>\\s*<string>__service-launcher<\\/string>)/,\n  /(<Arguments>--headless "[^"<]*?[\\\\/]runtime[\\\\/]versions[\\\\/])([^\\\\/"<]+)([\\\\/]t3\\.exe" "__service-launcher")/,',
        '  /^(ExecStart=.*?[\\\\/]runtime[\\\\/]versions[\\\\/])([^\\\\/\\s"]+)([\\\\/]t3)(?=["\\s])/m, // rebrand-keep\n  /(<string>[^<]*?[\\\\/]runtime[\\\\/]versions[\\\\/])([^\\\\/<]+)([\\\\/]t3<\\/string>\\s*<string>__service-launcher<\\/string>)/, // rebrand-keep\n  /(<Arguments>--headless "[^"<]*?[\\\\/]runtime[\\\\/]versions[\\\\/])([^\\\\/"<]+)([\\\\/]t3\\.exe" "__service-launcher")/, // rebrand-keep',
      ],
      [
        '  /^(ExecStart=.*?[\\\\/]runtime[\\\\/]versions[\\\\/])([^\\\\/\\s"]+)([\\\\/]simplycode)(?=["\\s])/m,\n  /(<string>[^<]*?[\\\\/]runtime[\\\\/]versions[\\\\/])([^\\\\/<]+)([\\\\/]simplycode<\\/string>\\s*<string>__service-launcher<\\/string>)/,\n  /(<Arguments>--headless "[^"<]*?[\\\\/]runtime[\\\\/]versions[\\\\/])([^\\\\/"<]+)([\\\\/]simplycode\\.exe" "__service-launcher")/,',
        '  /^(ExecStart=.*?[\\\\/]runtime[\\\\/]versions[\\\\/])([^\\\\/\\s"]+)([\\\\/]t3)(?=["\\s])/m, // rebrand-keep\n  /(<string>[^<]*?[\\\\/]runtime[\\\\/]versions[\\\\/])([^\\\\/<]+)([\\\\/]t3<\\/string>\\s*<string>__service-launcher<\\/string>)/, // rebrand-keep\n  /(<Arguments>--headless "[^"<]*?[\\\\/]runtime[\\\\/]versions[\\\\/])([^\\\\/"<]+)([\\\\/]t3\\.exe" "__service-launcher")/, // rebrand-keep',
      ],
    ],
  },
  {
    // The launcher record holds the launcher's own name (simplycode).
    file: "apps/server/src/cli/install.test.ts",
    edits: [
      [
        'fs.realPath(path.join(root, "bin"))}/t3\\n',
        'fs.realPath(path.join(root, "bin"))}/simplycode\\n',
      ],
    ],
  },
  {
    // PR/issue-link fixtures refer to the fork's own repo: the seeded URLs
    // and repository fields must spell the same repo or dedup breaks.
    file: "apps/server/src/orchestration-v2/runtimeLayer.test.ts",
    edits: [
      ["github.com/pingdotgg/t3code/pull/", `github.com/${FORK_REPO}/pull/`],
      ['repository: "Pingdotgg/T3code"', 'repository: "Kodji7202-Code/Simplycode"'],
      ['scope: "Pingdotgg/T3code"', 'scope: "Kodji7202-Code/Simplycode"'],
    ],
  },
  {
    // The stub asserts the manifest field name the query asks for: `t3code`.
    file: "apps/server/src/cloud/npmRelease.test.ts",
    edits: [
      [
        '`simplycode@${fixture.spec}`, "version", "t3code"],\n',
        '`simplycode@${fixture.spec}`, "version", "t3code"], // rebrand-keep\n',
      ],
      [
        '`simplycode@${fixture.spec}`, "version", "simplycode"],\n',
        '`simplycode@${fixture.spec}`, "version", "t3code"], // rebrand-keep\n',
      ],
      ["// rebrand-keep // rebrand-keep", "// rebrand-keep"],
    ],
  },
  {
    // The npm manifest field stays `t3code` (the Manifest schema reads it);
    // only the package spec follows the fork's name.
    file: "apps/server/src/cloud/npmRelease.ts",
    edits: [
      [
        '`simplycode@${spec}`, "version", "t3code"],\n',
        '`simplycode@${spec}`, "version", "t3code"], // rebrand-keep\n',
      ],
      [
        '`simplycode@${spec}`, "version", "simplycode"],\n',
        '`simplycode@${spec}`, "version", "t3code"], // rebrand-keep\n',
      ],
      // Repairs lines where an older rule appended the marker repeatedly.
      ["], // rebrand-keep // rebrand-keep", "], // rebrand-keep"],
    ],
  },
  {
    // The MCP subject-prefix matcher keeps the upstream `t3[-_]code` names:
    // the servers still register as t3-code / t3-code-direct (model-facing).
    file: "apps/server/src/feedback/FeedbackReport.ts",
    edits: [
      [
        "|t3[-_]?code(?:[-_]direct)?[.:/])/iu;\n",
        "|t3[-_]?code(?:[-_]direct)?[.:/])/iu; // rebrand-keep\n",
      ],
      [
        "|simplycode[-_]?code(?:[-_]direct)?[.:/])/iu;\n",
        "|t3[-_]?code(?:[-_]direct)?[.:/])/iu; // rebrand-keep\n",
      ],
      // Repairs lines where an older rule appended the marker repeatedly.
      ["// rebrand-keep // rebrand-keep", "// rebrand-keep"],
    ],
  },
  {
    // npm-global installs of this package live under its own name.
    file: "apps/server/src/cli/invocation.ts",
    edits: [
      ["lib\\/node_modules\\/t3\\/", "lib\\/node_modules\\/simplycode\\/"],
      ["bin\\/t3\\.mjs", "bin\\/simplycode\\.mjs"],
      ['"lib/node_modules/t3"', '"lib/node_modules/simplycode"'],
      ['"bin/t3"', '"bin/simplycode"'],
      ["manifest.bin.t3", "manifest.bin.simplycode"],
    ],
  },
  {
    // The automatic-port selector is offered the fork's default port, and the
    // desktop-mode resolution falls back to it too.
    file: "apps/server/src/cli/config.test.ts",
    edits: [
      [".toBe(3773);", ".toBe(4773);"],
      [
        '        [3773, undefined],\n        [3773, "100.64.0.7"],',
        '        [4773, undefined],\n        [4773, "100.64.0.7"],',
      ],
    ],
  },
  {
    // The fork ships no hosted surface: applinks domains, intent filters and
    // the .well-known files are empty unless SIMPLYCODE_CLERK_RP_DOMAIN is set.
    file: "apps/mobile/app.config.test.ts",
    edits: [
      ['import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";\n', ""],
      [
        '  // Copied thread links open this app only while app.t3.codes lists it.\n  const host = new URL(DEFAULT_HOSTED_APP_URL).host;\n  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);\n  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(\n    `${config.ios?.appleTeamId}.${identifier}`,\n  );\n  expect(config.android?.intentFilters?.[0]?.data).toEqual([\n    { scheme: "https", host, pathPrefix: "/threads/" },\n  ]);\n  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);',
        "  // The fork ships no hosted surface; applinks activate only when\n  // SIMPLYCODE_CLERK_RP_DOMAIN is set at build time.\n  expect(config.ios?.associatedDomains).toBeUndefined();\n  expect(config.android?.intentFilters).toEqual([]);\n  expect(appleAppSiteAssociation.applinks.details).toEqual([]);\n  expect(assetLinks).toEqual([]);",
      ],
      // Repair form for a tree where the scoped host rule already rewrote the
      // comment to hosted.simplycode.invalid.
      [
        '  // Copied thread links open this app only while hosted.simplycode.invalid lists it.\n  const host = new URL(DEFAULT_HOSTED_APP_URL).host;\n  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);\n  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(\n    `${config.ios?.appleTeamId}.${identifier}`,\n  );\n  expect(config.android?.intentFilters?.[0]?.data).toEqual([\n    { scheme: "https", host, pathPrefix: "/threads/" },\n  ]);\n  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);',
        "  // The fork ships no hosted surface; applinks activate only when\n  // SIMPLYCODE_CLERK_RP_DOMAIN is set at build time.\n  expect(config.ios?.associatedDomains).toBeUndefined();\n  expect(config.android?.intentFilters).toEqual([]);\n  expect(appleAppSiteAssociation.applinks.details).toEqual([]);\n  expect(assetLinks).toEqual([]);",
      ],
    ],
  },
  {
    file: "apps/web/src/components/settings/AboutVersionTitle.tsx",
    edits: [
      [
        `        </Tooltip>
      </code>
    </span>`,
        `        </Tooltip>
      </code>
      <span className="text-2xs text-muted-foreground">
        {gt("An unofficial fork of T3 Code. Not affiliated with T3 Tools, Inc.")}{" "}
        {/* rebrand-keep */}
      </span>
    </span>`,
      ],
      // Repairs a tree where the marker was formatter-split and the text pass
      // rebranded the attribution before the adjacent-line guard existed.
      [
        '{gt("An unofficial fork of SimplyCode. Not affiliated with T3 Tools, Inc.")}',
        '{gt("An unofficial fork of T3 Code. Not affiliated with T3 Tools, Inc.")}',
      ],
    ],
  },
  {
    file: "apps/mobile/src/components/CompactBrandTitle.tsx",
    edits: [
      ['const WORDMARK_SUFFIX = "Code";\n', ""],
      [
        `      {/* A logo beside a fixed-size wordmark: it may grow with Dynamic Type, not crowd the bar. */}
      <Text
        allowFontScaling={props.allowFontScaling}
        maxFontSizeMultiplier={BRAND_MAX_FONT_SCALE}
        className="font-t3-medium text-foreground-muted"
        style={{ fontSize: 21 * scale, letterSpacing: -0.5 * scale }}
      >
        {WORDMARK_SUFFIX}
      </Text>
`,
        "",
      ],
    ],
  },
  {
    file: "apps/desktop/gnome-extension/metadata.json",
    edits: [['"snap-shot@t3.codes"', '"snap-shot@simplycode.invalid"']],
  },
  {
    file: "scripts/build-desktop-artifact.ts",
    edits: [
      ['schemes: ["t3code", "t3code-dev"]', 'schemes: ["simplycode", "simplycode-dev"]'],
      ['executableName: "t3code"', 'executableName: "simplycode"'],
      ['name: "t3code-server"', 'name: "simplycode-server"'],
      ['name: "t3code"', 'name: "simplycode"'],
      ['"T3 Tools <hello@t3.codes>"', '"kodji7202-code <kodji7202-code@users.noreply.github.com>"'],
      ["com.t3tools.t3code.metainfo.xml", `${APP_ID}.metainfo.xml`],
    ],
  },
  {
    file: "package.json",
    edits: [
      [
        `"build": "vp run --filter './apps/*' build"`,
        `"build": "vp run --filter './apps/*' --filter '!@t3tools/marketing' build"`,
      ],
    ],
  },
  {
    file: "scripts/install.sh",
    edits: [
      ["${bin_dir}/t3", "${bin_dir}/simplycode"],
      ['"${t3_home}/bin/t3"', '"${t3_home}/bin/simplycode"'],
      ["command -v t3 ", "command -v simplycode "],
      ['pwd)/t3"', 'pwd)/simplycode"'],
    ],
  },
  {
    file: "scripts/install.ps1",
    edits: [['Join-Path $binDir "t3.cmd"', 'Join-Path $binDir "simplycode.cmd"']],
  },
  {
    file: ".env.example",
    edits: [
      ["https://app.t3.codes", HOSTED_APP_URL],
      ["https://nightly.app.t3.codes", `https://nightly.${HOSTED_APP_HOST}`],
    ],
  },
  {
    // Archive-internal executable name stays `t3`/`t3.exe`: every consumer that
    // extracts a release archive (install.sh validation, npm launcher,
    // service launcher, WSL runtime check) looks for that name.
    file: "scripts/build-cli-archive.ts",
    edits: [
      // EOL-anchored so a formatted `; /* rebrand-keep */` variant is not
      // matched again (the marker lands after the semicolon post-format).
      ['? "t3.exe" : "t3";\n', '? "t3.exe" : "t3"; /* rebrand-keep */\n'],
      // Repairs a tree where the substring find re-fired on the marked line.
      [
        '? "t3.exe" : "t3" /* rebrand-keep */; /* rebrand-keep */',
        '? "t3.exe" : "t3"; /* rebrand-keep */',
      ],
    ],
  },
  {
    // The desktop registers only simplycode schemes; the app-scheme matchers
    // must accept them or deep links and pairing links are silently dropped.
    file: "packages/shared/src/promptLinks.ts",
    edits: [
      ["/^t3code(?:-[a-z]+)?:$/", "/^simplycode(?:-[a-z]+)?:$/"],
      ['scheme = "t3code"', 'scheme = "simplycode"'],
    ],
  },
  {
    file: "packages/shared/src/remote.ts",
    edits: [["/^t3code(?:-[a-z]+)?:$/", "/^simplycode(?:-[a-z]+)?:$/"]],
  },
  {
    file: "apps/desktop/src/app/DesktopClerk.test.ts",
    edits: [['"/tmp/app-data/t3code-dev"', '"/tmp/app-data/simplycode-dev"']],
  },
  {
    file: "apps/desktop/src/app/DesktopLifecycle.test.ts",
    edits: [['"T3CODE://pair?token=spent"', '"SIMPLYCODE://pair?token=spent"']],
  },
  {
    file: "apps/desktop/src/app/DesktopCliCommand.test.ts",
    edits: [["`${home}/.t3`", "`${home}/.simplycode`"]],
  },
  {
    file: "apps/desktop/src/app/DesktopCliShim.test.ts",
    edits: [['"./bin/t3"', '"./bin/simplycode"']],
  },
  {
    file: "apps/desktop/src/app/DesktopLinuxUrlHandler.test.ts",
    edits: [
      ["x-scheme-handler/t3code", "x-scheme-handler/simplycode"],
      // A path without special characters is written unquoted.
      ['Exec="/opt/SimplyCode/t3code" %U', "Exec=/opt/SimplyCode/t3code %U"],
      // linuxThemeIconNames dedupes [lowercase, original]; the fork's
      // all-lowercase desktop id installs a single icon name.
      [
        '"io.github.kodji7202code.simplycode.png",\n        "io.github.kodji7202code.simplycode.png",',
        '"io.github.kodji7202code.simplycode.png",',
      ],
      [
        '"io.github.kodji7202code.simplycode",\n        "io.github.kodji7202code.simplycode",',
        '"io.github.kodji7202code.simplycode",',
      ],
      [
        `const lower = path.join(fixture.appsDir, "io.github.kodji7202code.simplycode.png");
      const upper = path.join(fixture.appsDir, "io.github.kodji7202code.simplycode.png");
      yield* fileSystem.writeFile(lower, new Uint8Array([3, 2, 1]));
      yield* fileSystem.writeFile(upper, new Uint8Array([1, 2, 3]));
      for (const target of [lower, upper]) {
        yield* fileSystem.utimes(target, fixture.pastSeconds, fixture.pastSeconds);
      }`,
        `const target = path.join(
        fixture.appsDir,
        "io.github.kodji7202code.simplycode.png",
      );
      yield* fileSystem.writeFile(target, new Uint8Array([3, 2, 1]));
      yield* fileSystem.utimes(target, fixture.pastSeconds, fixture.pastSeconds);`,
      ],
      [
        `assert.deepEqual([...(yield* fileSystem.readFile(lower))], [1, 2, 3]);
      const upperInfo = yield* fileSystem.stat(upper);
      assert.equal(Option.getOrThrow(upperInfo.mtime).getTime(), fixture.pastSeconds * 1000);`,
        `assert.deepEqual([...(yield* fileSystem.readFile(target))], [1, 2, 3]);`,
      ],
    ],
  },
  {
    file: "apps/desktop/src/app/DesktopPreReadyPlatform.test.ts",
    edits: [
      ["x-scheme-handler/t3code", "x-scheme-handler/simplycode"],
      ['Exec="/opt/SimplyCode/t3code" %U', "Exec=/opt/SimplyCode/t3code %U"],
    ],
  },
  {
    file: "apps/desktop/src/electron/ElectronProtocol.test.ts",
    edits: [["'self' t3code-dev:", "'self' simplycode-dev:"]],
  },
  {
    file: "packages/source-control-github/src/shared/definition.test.ts",
    edits: [
      ['repository: "t3tools/t3code"', 'repository: "t3tools/simplycode"'],
      [
        '"https://github.com/pingdotgg/t3code/pull/8600#issuecomment-1"',
        '"https://github.com/kodji7202-code/simplycode/pull/8600#issuecomment-1"',
      ],
    ],
  },
];

// Whole-file rewrites and moves (content is regenerated verbatim every run).

const README_MD = `# SimplyCode

SimplyCode is an **unofficial community fork** of [T3 Code](https://github.com/pingdotgg/t3code), a minimal open-source GUI for coding agents.

> **Disclaimer:** SimplyCode is not affiliated with, endorsed by, or supported by T3 Tools, Inc.
> "T3 Code" is a trademark of T3 Tools, Inc. This fork is based on the MIT-licensed
> T3 Code source code only — it ships no T3 Code branding, wordmark, or icons.

## Differences from upstream

- App name, wordmark, and icons are SimplyCode's.
- The CLI binary is \`simplycode\` (upstream's is \`t3\`); the default home directory
  is \`~/.simplycode\` and the default server port is 4773, so a fork install never
  collides with an official T3 Code install.
- Product telemetry is off unless you configure \`T3CODE_POSTHOG_KEY\` and
  \`T3CODE_POSTHOG_HOST\`; the fork ships no T3-owned ingest endpoint.
- There is no hosted web app; desktop/mobile deep links use the \`simplycode://\` scheme.

## Build

See [docs/user/install.md](docs/user/install.md) for install options and
[docs/operations/00_development.md](docs/operations/00_development.md) for the dev
setup (\`vp i\`, \`npm run dev\`).

## Merging upstream

\`git merge upstream/main\`, resolve conflicts by taking upstream on brand-edited
lines, then run \`node scripts/rebrand.ts\` — it is deterministic and idempotent.
`;

const TRADEMARK_MD = `# Trademark notice (SimplyCode fork)

SimplyCode is an unofficial fork of the T3 Code source code. It is **not
affiliated with, endorsed by, or sponsored by T3 Tools, Inc.**

"T3 Code", the T3 wordmark, and associated logos and app icons are trademarks of
T3 Tools, Inc. This repository ships none of them: the application name,
wordmark, and icons are SimplyCode's own. References to "T3 Code", "T3 Connect",
or "t3" in this repository are factual references to the upstream project, its
hosted service, or its MIT-licensed source code.

Upstream's trademark policy: see
[TRADEMARK.md in pingdotgg/t3code](https://github.com/pingdotgg/t3code/blob/main/TRADEMARK.md).
`;

const TELEMETRY_MD = `# Product usage data

SimplyCode ships with product telemetry **off by default**: the server sends
nothing unless you set both \`T3CODE_POSTHOG_KEY\` and \`T3CODE_POSTHOG_HOST\` to
point at an analytics backend you control. The fork ships no ingest endpoint and
sends no data to T3 Tools, Inc.

When configured, the server posts product usage events to your PostHog host,
associated with a hashed account or installation identifier. To count how many
installations one person uses, the server also sends hashed account identifiers:
your T3 Connect account, your OpenAI and Claude accounts when you are signed in,
and a random identifier for each device that connects. Events include the
provider, model, reasoning effort, permission mode, turn and request results,
duration, release channel, and token counts when available. Child-agent token
counts are reported separately from the main agent's. Events include the model ID
the provider used, including custom models and models served by a custom
endpoint.

Product events do not include prompts, responses, file contents, authentication
tokens, conversation IDs, raw provider events, or child-agent output. The one
exception is [agent feedback](#agent-feedback), which is off unless you turn it
on.

## Agent feedback

Agent feedback lets agents tell you about SimplyCode: a tool or \`simplycode\`
command that did not do what they expected, a confusing instruction, or a missing
capability. Choose a mode in **Agent feedback** in **Settings > Labs**:

- **Off**, the default: agents do not see the feedback tools, and \`simplycode feedback\` stops with a
  message pointing to Labs.
- **When I ask**: agents send a report only when you ask them to, about anything in SimplyCode.
- **Automatic**: agents also report SimplyCode problems they hit on their own, such as a tool that
  failed and made them find another way. These reports carry no outline and no message text, and
  go out without asking you. \`simplycode feedback --kind bug --subject "thread send" --expected "…" --actual "…"\`
  sends one the same way, so it works only in this mode.

When you ask your agent for a report, in either mode, SimplyCode shows it in the thread as a card
with exactly what would leave your machine, and sends it only if you press **Send**. The agent
carries on without waiting and never learns your answer. The card stays open until you answer it,
even after the turn ends or the server restarts; **Don't send** sends nothing, and the agent is
told not to send it another way. Only someone who can run agents on that machine can answer the
card; people on a guest link cannot.

Each report has the kind of problem, the tool or command it concerns (or \`general\`), and up to
300 characters each of expected behavior, actual behavior, and workaround, written by the agent,
which is told not to quote your messages or code. The agent also says how many recent turns the
problem spans. A report you approved carries an outline of those turns, and of at least the last 5,
from when the agent asked: who spoke, how long each message was, and which tools ran, whether they
worked, and how long they took. The outline has no text. Tools from your other MCP servers appear
only as \`mcp\`. Turn on **Include the conversation** in the card to attach the text of your
messages and the agent's replies in the turns the problem spans, up to 1,000 characters per
message and 16 KB in all, oldest text dropped first; the card shows that text before you send it.
To change a report, such as the turns it covers, ask the agent in the chat: it shows a new card,
and you can decline the old one. Tool inputs and outputs, files, and attachments are never sent. An agent can
show you at most 3 report cards and send 3 reports on its own per turn, and \`simplycode feedback\` can
send at most 10 an hour.

Before anything is saved, SimplyCode removes file paths (when text mentions one, the rest of that line
goes with it), your user name, machine name, project title, branch, and git remote, and anything
that looks like a key, token, email address, or URL with a password. It cannot recognise your code
or a name written in a sentence, so only include the conversation when it holds nothing you would
not send. Reports from agents also name the provider and the model. No thread IDs or project IDs
are sent.

Reports stay on your machine; a declined one is not saved at all, and its card keeps
only what you would have sent without the conversation. \`simplycode feedback list\` shows recent
reports, the thread each came from, and a line for each outline; \`simplycode feedback list --json\` shows
exactly what each one holds.

## Relay connection diagnostics

If you opt in to T3 Connect, SimplyCode sends relay connection traces to the
configured relay to diagnose connectivity. These are separate from product
events. Depending on the client version, traces can include connection timings,
environment identifiers and the connected machine's name. Failed spans can
include error messages and stack traces; error text can quote a value the app was
handling.

To disable product events and relay tracing from the server, set
\`T3CODE_TELEMETRY_ENABLED=false\` in its environment before starting it. Relay tracing also stops
when \`T3CODE_OTEL_SDK_DISABLED\` or \`OTEL_SDK_DISABLED\` turns OpenTelemetry export off.

An administrator can turn product events and relay tracing off in the server and desktop app with
a [managed policy](./managed-policy.md#other-capabilities). This does not control traces sent by
separate browser or mobile clients.

The desktop app reads \`T3CODE_TELEMETRY_ENABLED\` from your shell profile (for example \`~/.zshrc\`) on macOS and
Linux, so export it there and restart the app. On Windows, set it as a user environment variable.

## Mobile app diagnostics

When the iOS or Android app crashes or hits an error, it can send a report: the error
message, the stack trace, the app version, and the device model and OS version. Each launch also
sends startup timings, and every report carries a random ID for the install. Reports go through
the T3 Connect relay and only exist when a relay is configured. They do not include your threads,
prompts, or connection details, but an error message can quote a value the app was handling.

To stop sending them, turn off **Send crash reports** in **Settings > About SimplyCode > Diagnostics**.

## Agent activity for mobile notifications

When **Publish agent activity** is enabled on a host, it sends project and thread titles, model
names, activity status, and environment and thread identifiers to the configured relay for
[mobile notifications and live activities](./mobile-notifications.md). This is separate from
product events and relay diagnostics. The telemetry opt-out does not disable it.

To stop publishing, turn off **Publish agent activity** under **Settings > Sharing & access** on
the host. Turning off notifications on a phone controls that phone's alerts, not the host's
publishing setting.

## Export diagnostics to your own receiver

To send traces, metrics, or logs to an OpenTelemetry receiver, open
**Settings > Maintenance > Diagnostics**, select an environment, and enter each signal's OTLP HTTP
endpoint under **OpenTelemetry export** (for example \`http://localhost:4318/v1/traces\`). Save, then
restart that environment's server. The receiver must be reachable from the server's machine.
**Test** sends an empty export from the server to check an endpoint before or after you save it.
`;

const METAINFO_XML = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${APP_ID}</id>
  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>
  <name>SimplyCode</name>
  <summary>Desktop GUI for coding agents</summary>
  <developer id="io.github.kodji7202code">
    <name>SimplyCode contributors</name>
  </developer>
  <description>
    <p>
      SimplyCode is an open-source desktop app for coding agents. Work with your
      existing agent subscriptions, review code changes, and run commands in
      your projects.
    </p>
    <p>
      Connect from desktop, web, or mobile to continue working remotely.
    </p>
    <p>
      SimplyCode is an unofficial fork of T3 Code and is not affiliated with
      T3 Tools, Inc.
    </p>
  </description>
  <launchable type="desktop-id">simplycode.desktop</launchable>
  <icon type="stock">simplycode</icon>
  <provides>
    <binary>simplycode</binary>
  </provides>
  <categories>
    <category>Development</category>
  </categories>
  <url type="homepage">${FORK_REPO_URL}</url>
  <url type="bugtracker">${FORK_REPO_URL}/issues</url>
  <url type="vcs-browser">${FORK_REPO_URL}</url>
</component>
`;

function dmgBackgroundSvg(channelLabel: string): string {
  return `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="864" viewBox="0 0 640 432">
  <defs>
    <linearGradient id="veil" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="#B7B7B7" stop-opacity="0"/>
      <stop offset=".55" stop-color="#A5A5A5" stop-opacity=".24"/>
      <stop offset="1" stop-color="#D1D1D1" stop-opacity=".4"/>
    </linearGradient>
    <linearGradient id="silk" x1="0" y1="0" x2="1" y2="0">
      <stop stop-color="#C8C8C8"/>
      <stop offset=".5" stop-color="#DBDBDB"/>
      <stop offset="1" stop-color="#B5B5B5"/>
    </linearGradient>
  </defs>
  <rect width="640" height="432" fill="#E9E9EB"/>
  <path d="M-60 293C95 220 214 304 362 256S559 191 707 257" stroke="url(#veil)" stroke-width="146" fill="none" opacity="1" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M-60 306C113 252 223 298 367 272S553 242 707 280" stroke="url(#silk)" stroke-width="86" fill="none" opacity="1" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M-60 266C113 212 223 258 367 232S553 202 707 240" stroke="#F5F5F5" stroke-width="0.8" fill="none" opacity="0.42" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="320" y="104" fill="#303034" font-family="Helvetica" font-size="23" font-weight="700" text-anchor="middle">Drag SimplyCode${channelLabel} into Applications.</text>
  <path d="M270 204Q320 179 370 204M358 190L370 204L351 209" stroke="#505057" stroke-width="2.2" fill="none" opacity="1" stroke-linecap="round" stroke-linejoin="round"/>
  <text x="320" y="367" fill="#626269" font-family="Helvetica" font-size="12" font-weight="400" text-anchor="middle">Once copied, open it from Applications.</text>
</svg>
`;
}

const WEB_WORDMARK = `import type { SVGProps } from "react";

// SimplyCode wordmark: plain text so it inherits the caller's font and color.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 190 40" xmlns="http://www.w3.org/2000/svg">
      <text
        x="0"
        y="30"
        fill="currentColor"
        fontFamily="inherit"
        fontSize="32"
        fontWeight="700"
        letterSpacing="-0.5"
      >
        SimplyCode
      </text>
    </svg>
  );
}
`;

const MOBILE_WORDMARK = `import type { ColorValue } from "react-native";
import Svg, { Text } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedText = withUniwind(Text);

// SimplyCode wordmark: plain text so it inherits the caller's font and color.
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 190 / 40;
  return (
    <Svg
      accessibilityLabel="SimplyCode"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="0 0 190 40"
    >
      <ThemedText
        x="0"
        y="32"
        fontSize="34"
        fontWeight="700"
        fill="currentColor"
        color={props.color}
        colorClassName={props.colorClassName}
      >
        SimplyCode
      </ThemedText>
    </Svg>
  );
}
`;

const FILE_REWRITES: ReadonlyArray<{ file: string; content: string }> = [
  { file: "README.md", content: README_MD },
  { file: "TRADEMARK.md", content: TRADEMARK_MD },
  { file: "docs/user/telemetry.md", content: TELEMETRY_MD },
  { file: "apps/web/src/components/T3Wordmark.tsx", content: WEB_WORDMARK },
  { file: "apps/mobile/src/components/T3Wordmark.tsx", content: MOBILE_WORDMARK },
  {
    file: "apps/desktop/resources/dmg/dmg-background-latest.svg",
    content: dmgBackgroundSvg(""),
  },
  {
    file: "apps/desktop/resources/dmg/dmg-background-nightly.svg",
    content: dmgBackgroundSvg(" Nightly"),
  },
  {
    file: "apps/web/public/.well-known/assetlinks.json",
    content: "[]\n",
  },
  {
    file: "apps/web/public/.well-known/apple-app-site-association.json",
    content: JSON.stringify({ applinks: { details: [] } }, null, 2) + "\n",
  },
  {
    file: `apps/desktop/resources/linux/${APP_ID}.metainfo.xml`,
    content: METAINFO_XML,
  },
];

const FILE_MOVES: ReadonlyArray<{ from: string; to: string }> = [
  {
    from: "apps/desktop/resources/linux/com.t3tools.t3code.metainfo.xml",
    to: `apps/desktop/resources/linux/${APP_ID}.metainfo.xml`,
  },
  {
    from: "scripts/npm-launcher/t3.mjs",
    to: "scripts/npm-launcher/simplycode.mjs",
  },
  {
    from: "packaging/aur/t3code-bin",
    to: "packaging/aur/simplycode-bin",
  },
  {
    from: "packaging/aur/t3code-nightly-bin",
    to: "packaging/aur/simplycode-nightly-bin",
  },
];

// LICENSE gains a fork copyright line; MIT text and T3 copyright stay intact.
const LICENSE_ADD_LINE = "Copyright (c) 2026 kodji7202-code (SimplyCode modifications)";

// i18n: snapshot -> regenerate -> map rebranded English onto old translations.

const I18N_APPS = ["apps/web", "apps/mobile", "apps/desktop"] as const;

// Engine

const changedFiles: string[] = [];
const staleEdits: string[] = [];
const missingFiles: string[] = [];

function isExcluded(relPosix: string): boolean {
  if (EXCLUDED_FILES.has(relPosix)) return true;
  // t3.json project files keep their upstream $schema URL (client compat).
  if (relPosix === "t3.json" || relPosix.endsWith("/t3.json")) return true;
  if (BINARY_SUFFIXES.some((s) => relPosix.endsWith(s))) return true;
  if (relPosix.includes("/i18n/translations/")) return true;
  return EXCLUDED_PREFIXES.some((p) => relPosix.startsWith(p));
}

function* walk(dir: string): Generator<string> {
  for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function isStandaloneKeepLine(line: string): boolean {
  const t = line.trim();
  return t === "// rebrand-keep" || t === "/* rebrand-keep */" || t === "{/* rebrand-keep */}";
}

function applyLine(
  line: string,
  scopedRules: ReadonlyArray<readonly [string, string]>,
  regexRules: ReadonlyArray<{ re: RegExp; to: string }> = REGEX_RULES,
): string {
  if (line.includes(KEEP_MARKER)) return line;
  let out = line;
  for (const [find, replace] of TEXT_RULES) {
    if (out.includes(find)) out = out.split(find).join(replace);
  }
  for (const [find, replace] of scopedRules) {
    if (out.includes(find)) out = out.split(find).join(replace);
  }
  for (const { re, to } of regexRules) {
    out = out.replace(re, to);
  }
  return out;
}

const ALL_SCOPED_RULES = SCOPED_TEXT_RULES.flatMap((s) => s.rules);

/** Same transformation as applyLine, applied recursively to catalog values
 *  (entries can be strings, arrays, or plural objects). */
function rebrandCatalogValue(value: unknown): unknown {
  if (typeof value === "string") return applyLine(value, ALL_SCOPED_RULES);
  if (Array.isArray(value)) return value.map(rebrandCatalogValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rebrandCatalogValue(v)]));
  }
  return value;
}

function scopedRulesFor(relPosix: string): ReadonlyArray<readonly [string, string]> {
  return SCOPED_TEXT_RULES.filter((s) => s.prefixes.some((p) => relPosix.startsWith(p))).flatMap(
    (s) => s.rules,
  );
}

function writeIfChanged(rel: string, content: string) {
  const abs = NodePath.join(REPO_ROOT, rel);
  const prev = NodeFS.existsSync(abs) ? NodeFS.readFileSync(abs, "utf8") : null;
  if (prev === content) return;
  NodeFS.mkdirSync(NodePath.dirname(abs), { recursive: true });
  NodeFS.writeFileSync(abs, content);
  changedFiles.push(rel);
}

function applyFileEditsToContent(rel: string, content: string): string {
  const group = FILE_EDITS.find((f) => f.file === rel);
  if (group) {
    for (const [find, replace] of group.edits) {
      if (find === replace) continue;
      if (content.includes(find)) {
        content = content.split(find).join(replace);
      } else if (replace !== "" && !content.includes(replace)) {
        staleEdits.push(`${rel}: ${find.slice(0, 72)}`);
      }
    }
  }
  const scoped = scopedRulesFor(rel);
  const regexRules = REGEX_RULES.filter(
    (r) => !r.except?.some((p) => rel === p || rel.startsWith(p.endsWith("/") ? p : `${p}/`)),
  );
  const lines = content.split("\n");
  let touched = false;
  for (let i = 0; i < lines.length; i++) {
    // A standalone marker line also guards the code line next to it: formatters
    // can split an inline `{/* rebrand-keep */}` onto its own line.
    const markerGuard =
      (i > 0 && isStandaloneKeepLine(lines[i - 1])) ||
      (i + 1 < lines.length && isStandaloneKeepLine(lines[i + 1]));
    const next = markerGuard ? lines[i] : applyLine(lines[i], scoped, regexRules);
    if (next !== lines[i]) {
      lines[i] = next;
      touched = true;
    }
  }
  return touched ? lines.join("\n") : content;
}

function ensureLicenseLine() {
  const rel = "LICENSE";
  const abs = NodePath.join(REPO_ROOT, rel);
  const content = NodeFS.readFileSync(abs, "utf8");
  if (content.includes(LICENSE_ADD_LINE)) return;
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => l.trim().startsWith("Copyright (c)"));
  if (idx === -1) {
    staleEdits.push("LICENSE: no Copyright (c) line found to extend");
    return;
  }
  lines.splice(idx + 1, 0, LICENSE_ADD_LINE);
  writeIfChanged(rel, lines.join("\n"));
}

function readCatalogs(dir: string): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!NodeFS.existsSync(dir)) return out;
  for (const name of NodeFS.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const locale = name.slice(0, -5);
    out.set(locale, JSON.parse(NodeFS.readFileSync(NodePath.join(dir, name), "utf8")));
  }
  return out;
}

function writeCatalogs(dir: string, catalogs: Map<string, Record<string, unknown>>) {
  for (const [locale, catalog] of catalogs) {
    const file = NodePath.join(dir, `${locale}.json`);
    const body = JSON.stringify(catalog, null, 2) + "\n";
    const prev = NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : null;
    if (prev !== body) {
      NodeFS.writeFileSync(file, body);
      changedFiles.push(NodePath.relative(REPO_ROOT, file).split(NodePath.sep).join("/"));
    }
  }
}

function runI18nGenerate(appRel: string) {
  const appDir = NodePath.join(REPO_ROOT, appRel);
  const env = {
    ...process.env,
    PATH: `${process.env.VP_HOME ? `${process.env.VP_HOME}${NodePath.sep}bin${NodePath.delimiter}` : ""}${process.env.PATH}`,
  };
  if (appRel === "apps/desktop") {
    NodeChildProcess.execFileSync(process.execPath, ["scripts/i18n-generate.mjs"], {
      cwd: appDir,
      env,
      stdio: "inherit",
    });
    return;
  }
  NodeChildProcess.execFileSync("vp", ["run", "i18n:generate"], {
    cwd: appDir,
    env,
    stdio: "inherit",
    shell: true,
  });
}

function rebrandI18n() {
  for (const appRel of I18N_APPS) {
    const dir = NodePath.join(REPO_ROOT, appRel, "src", "i18n", "translations");
    const before = readCatalogs(dir);
    const oldEn = before.get("en") ?? {};

    // new English source (JSON-canonicalized) -> rebranded per-locale values.
    const translationsByNewEnglish = new Map<string, Map<string, unknown>>();
    for (const [key, enVal] of Object.entries(oldEn)) {
      const rebranded = rebrandCatalogValue(enVal);
      if (JSON.stringify(rebranded) === JSON.stringify(enVal)) continue;
      const mapKey = JSON.stringify(rebranded);
      let perLocale = translationsByNewEnglish.get(mapKey);
      if (!perLocale) {
        perLocale = new Map();
        translationsByNewEnglish.set(mapKey, perLocale);
      }
      for (const [locale, catalog] of before) {
        if (locale === "en") continue;
        const oldLocalized = catalog[key];
        if (oldLocalized !== undefined) {
          perLocale.set(locale, rebrandCatalogValue(oldLocalized));
        }
      }
    }

    runI18nGenerate(appRel);

    const after = readCatalogs(dir);
    const newEn = after.get("en") ?? {};
    let remapped = 0;
    for (const [key, newVal] of Object.entries(newEn)) {
      const saved = translationsByNewEnglish.get(JSON.stringify(newVal));
      if (!saved) continue;
      remapped++;
      for (const [locale, catalog] of after) {
        if (locale === "en") continue;
        const localized = saved.get(locale);
        if (localized !== undefined) catalog[key] = localized;
      }
    }
    writeCatalogs(dir, after);
    console.log(`[i18n] ${appRel}: remapped ${remapped} rebranded key(s)`);
  }
}

function main() {
  // Rewrite/move targets are regenerated verbatim below; running text rules on
  // them would toggle lines like "fork of T3 Code" back and forth each run.
  const verbatimFiles = new Set([
    ...FILE_REWRITES.map((r) => r.file),
    ...FILE_MOVES.flatMap((m) => [m.from, m.to]),
  ]);

  // 1. Per-file anchored edits + blanket rules on every in-scope text file.
  for (const abs of walk(REPO_ROOT)) {
    const rel = NodePath.relative(REPO_ROOT, abs).split(NodePath.sep).join("/");
    if (isExcluded(rel) || verbatimFiles.has(rel)) continue;
    const content = NodeFS.readFileSync(abs, "utf8");
    if (content.includes(String.fromCharCode(0))) continue; // binary file
    const rewritten = applyFileEditsToContent(rel, content);
    if (rewritten !== content) {
      NodeFS.writeFileSync(abs, rewritten);
      changedFiles.push(rel);
    }
  }
  for (const f of FILE_EDITS) {
    if (!NodeFS.existsSync(NodePath.join(REPO_ROOT, f.file))) missingFiles.push(f.file);
  }

  // 2. Whole-file rewrites, moves, LICENSE line.
  for (const { file, content } of FILE_REWRITES) writeIfChanged(file, content);
  for (const { from, to } of FILE_MOVES) {
    const absFrom = NodePath.join(REPO_ROOT, from);
    const absTo = NodePath.join(REPO_ROOT, to);
    if (!NodeFS.existsSync(absFrom)) continue;
    NodeFS.mkdirSync(NodePath.dirname(absTo), { recursive: true });
    if (NodeFS.existsSync(absTo)) {
      NodeFS.rmSync(absFrom, { recursive: true });
    } else {
      NodeFS.renameSync(absFrom, absTo);
    }
    changedFiles.push(`${from} -> ${to}`);
  }
  ensureLicenseLine();

  // 3. i18n catalogs.
  if (NO_I18N) {
    console.log("[i18n] skipped (--no-i18n)");
  } else {
    rebrandI18n();
  }

  console.log(`\nrebrand: ${changedFiles.length} file(s) written`);
  if (process.env.REBRAND_VERBOSE) {
    for (const f of changedFiles) console.log(`  wrote ${f}`);
  }
  if (staleEdits.length) {
    console.log(`stale FILE_EDITS (find text absent):`);
    for (const s of staleEdits) console.log(`  - ${s}`);
  }
  if (missingFiles.length) {
    console.log(`missing files:`);
    for (const s of missingFiles) console.log(`  - ${s}`);
  }
}

main();
