// Source readers for bot import. Each reader turns one BotImportSource into
// ScannedBot records holding everything apply needs, not just what the wire
// preview carries. Readers only read; OpenBot's live database is copied to a
// temp dir first so it is never opened.
import {
  BOT_AVATAR_COLORS,
  BOT_MEMORY_MAX_BYTES,
  BOT_SOUL_MAX_BYTES,
  BotApprovalMode,
  BotAvatar,
  type BotImportSource,
  type BotLimits,
  botAvatarOrDefault,
  ProviderInteractionMode,
  type ScheduledTaskUpsertSchedule,
} from "@t3tools/contracts";
import * as NodeSqlite from "node:sqlite";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as HostProcess from "@t3tools/shared/HostProcess";

const SKILL_FILE = "SKILL.md";
const PACKAGE_MAX_BYTES = 10 * 1024 * 1024;
const AGENTS_MD_CAP = BOT_SOUL_MAX_BYTES;

export interface ScannedSkillFile {
  readonly path: string;
  readonly data: Uint8Array;
}

export interface ScannedSkill {
  readonly name: string;
  readonly files: ReadonlyArray<ScannedSkillFile>;
}

export interface ScannedAutomation {
  readonly name: string;
  readonly prompt: string;
  readonly schedule: ScheduledTaskUpsertSchedule | undefined;
  readonly scheduleLabel: string;
  readonly importable: boolean;
}

export interface ScannedBot {
  readonly key: string;
  readonly name: string;
  readonly role: string | undefined;
  readonly description: string | undefined;
  readonly avatar: BotAvatar | undefined;
  /** The source's provider id or kind, for model mapping. */
  readonly sourceProvider: string | undefined;
  /** The source's model slug, for model mapping. */
  readonly sourceModelSlug: string | undefined;
  /** Display label like "swe-2-high (devin)". */
  readonly sourceModel: string | undefined;
  readonly approvalMode: BotApprovalMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly limits: BotLimits | undefined;
  readonly soul: string;
  readonly memory: string;
  readonly skills: ReadonlyArray<ScannedSkill>;
  readonly automations: ReadonlyArray<ScannedAutomation>;
  readonly warnings: string[];
}

export interface ScannedSource {
  readonly sourceLabel: string;
  readonly bots: ReadonlyArray<ScannedBot>;
  readonly warnings: string[];
}

export class BotImportSourceError extends Schema.TaggedError<BotImportSourceError>()(
  "BotImportSourceError",
  { message: Schema.String },
) {}

const sourceError = (message: string) => Effect.fail(new BotImportSourceError({ message }));

// Cuts to the cap on a code-point boundary; callers add their own warning.
const cutToBytes = (text: string, maxBytes: number): string => {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && ((bytes.at(end) ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
};

const cutSoul = (soul: string, warnings: string[]): string => {
  const cut = cutToBytes(soul, AGENTS_MD_CAP);
  if (cut !== soul) warnings.push(`Instructions are larger than 24 KB and were cut off.`);
  return cut;
};

const cutMemory = (memory: string, warnings: string[]): string => {
  const cut = cutToBytes(memory, BOT_MEMORY_MAX_BYTES);
  if (cut !== memory) warnings.push(`Memory is larger than 16 KB and was cut off.`);
  return cut;
};

const humanize = (slug: string): string =>
  slug
    .split(/[-_]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");

// Profile fields have wire caps (name 100/no-newline, role 60/no-newline,
// description 1000); over-cap text is cut at a code-point boundary with a warning.
const clipProfileField = (
  value: string | undefined,
  max: number,
): { value: string | undefined; warning: string | undefined } => {
  if (value === undefined) return { value: undefined, warning: undefined };
  const flat = value.replace(/[\r\n]+/g, " ").trim();
  if (flat === "") return { value: undefined, warning: undefined };
  const clipped = [...flat].slice(0, max).join("");
  return {
    value: clipped,
    warning: clipped === flat ? undefined : `was cut to ${max} characters.`,
  };
};

// hue (0-360) → the closest swatch hue, circular distance.
const hexToHue = (hex: string): number => {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
};

const closestAvatarColor = (hue: number): string => {
  let best: string = BOT_AVATAR_COLORS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const color of BOT_AVATAR_COLORS) {
    const d = Math.abs(hexToHue(color) - hue);
    const distance = Math.min(d, 360 - d);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = color;
    }
  }
  return best;
};

const readTextFile = Effect.fnUntraced(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const result = yield* fileSystem.readFileString(filePath, "utf8").pipe(Effect.result);
  return Result.isSuccess(result) ? result.success : undefined;
});

// Every file under `dir`, as paths relative to it with `/` separators.
const readSkillDir = Effect.fnUntraced(function* (dir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: ScannedSkillFile[] = [];
  const pending = [dir];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = yield* fileSystem.readDirectory(current);
    for (const entry of entries) {
      const full = path.join(current, entry);
      const info = yield* fileSystem.lstat(full);
      if (info.type === "Directory") {
        pending.push(full);
      } else if (info.type === "File") {
        const data = yield* fileSystem.readFile(full);
        files.push({ path: path.relative(dir, full).split(path.sep).join("/"), data });
      }
    }
  }
  return files;
});

// Skill folders under the given roots that contain a SKILL.md, deduped by
// folder name; earlier roots win.
const readSkills = Effect.fnUntraced(function* (roots: ReadonlyArray<string>) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const seen = new Set<string>();
  const skills: ScannedSkill[] = [];
  for (const root of roots) {
    const entries = yield* fileSystem.readDirectory(root).pipe(Effect.result);
    if (Result.isFailure(entries)) continue;
    for (const entry of entries.success) {
      const dir = path.join(root, entry);
      const info = yield* fileSystem.stat(dir).pipe(Effect.result);
      if (Result.isFailure(info) || info.success.type !== "Directory") continue;
      if (seen.has(entry)) continue;
      const hasSkill = yield* fileSystem
        .exists(path.join(dir, SKILL_FILE))
        .pipe(Effect.orElseSucceed(() => false));
      if (!hasSkill) continue;
      const files = yield* readSkillDir(dir).pipe(Effect.result);
      if (Result.isFailure(files)) continue;
      seen.add(entry);
      skills.push({ name: entry, files: files.success });
    }
  }
  return skills;
});

const instructionCandidates = ["SOUL.md", "AGENTS.md", "CLAUDE.md"] as const;

const frontmatterName = (text: string): string | undefined => {
  if (!text.startsWith("---")) return undefined;
  const end = text.indexOf("\n---", 3);
  const frontmatter = end === -1 ? text : text.slice(0, end);
  const value = /^name:[ \t]*(.+?)[ \t]*$/m.exec(frontmatter)?.[1];
  if (value === undefined) return undefined;
  const unquoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
      ? value.slice(1, -1)
      : value;
  const cleaned = unquoted.trim();
  return cleaned.length === 0 ? undefined : cleaned;
};

const folderBot = Effect.fnUntraced(function* (
  dir: string,
): Effect.fn.Return<
  ScannedBot | undefined,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const path = yield* Path.Path;
  let instructions: string | undefined;
  for (const file of instructionCandidates) {
    const text = yield* readTextFile(path.join(dir, file));
    if (text !== undefined) {
      instructions = text;
      break;
    }
  }
  if (instructions === undefined) return undefined;
  const warnings: string[] = [];
  const memory = (yield* readTextFile(path.join(dir, "MEMORY.md"))) ?? "";
  const skills = yield* readSkills([
    path.join(dir, "skills"),
    path.join(dir, ".agents", "skills"),
    path.join(dir, ".claude", "skills"),
  ]);
  const clippedName = clipProfileField(
    frontmatterName(instructions) ?? humanize(path.basename(dir)),
    100,
  );
  if (clippedName.warning !== undefined) warnings.push(`Name ${clippedName.warning}`);
  return {
    key: dir,
    name: clippedName.value ?? humanize(path.basename(dir)),
    role: undefined,
    description: undefined,
    avatar: undefined,
    sourceProvider: undefined,
    sourceModelSlug: undefined,
    sourceModel: undefined,
    approvalMode: "ask",
    interactionMode: undefined,
    limits: undefined,
    soul: cutSoul(instructions, warnings),
    memory: cutMemory(memory, warnings),
    skills,
    automations: [],
    warnings,
  };
});

const scanFolder = Effect.fnUntraced(function* (
  folderPath: string,
): Effect.fn.Return<
  ScannedSource,
  BotImportSourceError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const info = yield* fileSystem.stat(folderPath).pipe(Effect.result);
  if (Result.isFailure(info) || info.success.type !== "Directory") {
    return yield* sourceError(`"${folderPath}" is not a folder.`);
  }
  const single = yield* folderBot(folderPath);
  if (single !== undefined) {
    return { sourceLabel: folderPath, bots: [single], warnings: [] };
  }
  // No instruction file at the top: treat each subfolder holding one as a bot.
  const entries = yield* fileSystem.readDirectory(folderPath);
  const bots: ScannedBot[] = [];
  for (const entry of entries) {
    const dir = path.join(folderPath, entry);
    const sub = yield* fileSystem.stat(dir).pipe(Effect.result);
    if (Result.isFailure(sub) || sub.success.type !== "Directory") continue;
    const bot = yield* folderBot(dir);
    if (bot !== undefined) bots.push(bot);
  }
  if (bots.length === 0) {
    return yield* sourceError(
      `"${folderPath}" has no SOUL.md, AGENTS.md or CLAUDE.md, and no subfolder does either.`,
    );
  }
  return { sourceLabel: folderPath, bots, warnings: [] };
});

const openbotDbPath = Effect.fnUntraced(function* () {
  const home = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  switch (yield* HostProcess.Platform) {
    case "win32": {
      const appData = env.APPDATA;
      return appData === undefined ? undefined : `${appData}\\OpenBot\\openbot.db`;
    }
    case "darwin":
      return `${home}/Library/Application Support/OpenBot/openbot.db`;
    default: {
      const configHome = env.XDG_CONFIG_HOME ?? `${home}/.config`;
      return `${configHome}/OpenBot/openbot.db`;
    }
  }
});

interface OpenBotAgent {
  readonly id: string;
  readonly name?: string;
  readonly title?: string;
  readonly description?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly access?: string;
  readonly reasoningEffort?: string;
  readonly avatarHue?: number;
  readonly workspacePath?: string;
}

const openbotSchedule = (
  raw: string | null,
  timezone: string | null,
  warnings: string[],
): { schedule: ScheduledTaskUpsertSchedule | undefined; label: string; importable: boolean } => {
  if (raw === null) return { schedule: undefined, label: "No trigger", importable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { schedule: undefined, label: "Unreadable trigger", importable: false };
  }
  const trigger = parsed as { kind?: string; time?: string; weekday?: number };
  if (typeof trigger.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(trigger.time)) {
    return {
      schedule: undefined,
      label: `Unsupported schedule (${String(trigger.kind ?? "unknown")})`,
      importable: false,
    };
  }
  const serverZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (
    timezone !== null &&
    timezone !== serverZone &&
    !warnings.some((w) => w.startsWith("Routine timezone"))
  ) {
    warnings.push(
      `Routine timezone ${timezone} differs from this server's ${serverZone}; times are kept as written.`,
    );
  }
  if (trigger.kind === "weekdays") {
    return {
      schedule: { type: "fixed_time", timeOfDay: trigger.time, weekdays: [1, 2, 3, 4, 5] },
      label: `Weekdays at ${trigger.time}`,
      importable: true,
    };
  }
  if (trigger.kind === "weekly" && typeof trigger.weekday === "number") {
    const weekday = ((trigger.weekday % 7) + 7) % 7;
    return {
      schedule: { type: "fixed_time", timeOfDay: trigger.time, weekdays: [weekday] },
      label: `Weekly at ${trigger.time}`,
      importable: true,
    };
  }
  return {
    schedule: undefined,
    label: `Unsupported schedule (${String(trigger.kind ?? "unknown")})`,
    importable: false,
  };
};

const parseAgentJson = (raw: string): OpenBotAgent | undefined => {
  try {
    return JSON.parse(raw) as OpenBotAgent;
  } catch {
    return undefined;
  }
};

interface OpenBotRoutineRow {
  readonly name: string;
  readonly instruction: string;
  readonly timezone: string | null;
  readonly scheduleJson: string | null;
}

interface OpenBotRow {
  readonly agent: OpenBotAgent;
  /** Memory texts, essential first, then by created_at. */
  readonly memories: ReadonlyArray<string>;
  readonly routines: ReadonlyArray<OpenBotRoutineRow>;
}

// Everything sqlite, in one plain function so the generator stays Effect-only.
const readOpenBotData = (dbFile: string): ReadonlyArray<OpenBotRow> => {
  const db = new NodeSqlite.DatabaseSync(dbFile, { readOnly: true });
  try {
    const agentRows = db
      .prepare("SELECT agent_id, agent_json FROM projection_agents ORDER BY sort_order")
      .all() as unknown as ReadonlyArray<{ agent_id: string; agent_json: string }>;
    const rows: OpenBotRow[] = [];
    for (const row of agentRows) {
      const agent = parseAgentJson(row.agent_json);
      if (agent === undefined) continue;
      const memories = (
        db
          .prepare(
            `SELECT m.text AS text
             FROM projection_agent_memories m
             JOIN agent_memory_selections s ON s.memory_id = m.memory_id
             WHERE m.agent_id = ?
             ORDER BY CASE WHEN s.inclusion = 'essential' THEN 0 ELSE 1 END, m.created_at`,
          )
          .all(row.agent_id) as unknown as ReadonlyArray<{ text: string }>
      ).map((memory) => memory.text);
      const routines = (
        db
          .prepare(
            `SELECT r.name AS name, r.instruction AS instruction,
                    r.timezone AS timezone, t.schedule_json AS schedule_json
             FROM projection_agent_routines r
             LEFT JOIN projection_routine_triggers t ON t.routine_id = r.routine_id
             WHERE r.agent_id = ?`,
          )
          .all(row.agent_id) as unknown as ReadonlyArray<{
          name: string;
          instruction: string;
          timezone: string | null;
          schedule_json: string | null;
        }>
      ).map((routine) => ({
        name: routine.name,
        instruction: routine.instruction,
        timezone: routine.timezone,
        scheduleJson: routine.schedule_json,
      }));
      rows.push({ agent, memories, routines });
    }
    return rows;
  } finally {
    db.close();
  }
};

const scanOpenBot = Effect.fnUntraced(function* (): Effect.fn.Return<
  ScannedSource,
  BotImportSourceError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const dbPath = yield* openbotDbPath();
  if (
    dbPath === undefined ||
    !(yield* fileSystem.exists(dbPath).pipe(Effect.orElseSucceed(() => false)))
  ) {
    return yield* sourceError("No local OpenBot install was found on this computer.");
  }
  return yield* scanOpenBotDb(dbPath);
});

// Exported for tests, which point it at a fixture database.
export const scanOpenBotDb = Effect.fnUntraced(function* (
  dbPath: string,
): Effect.fn.Return<
  ScannedSource,
  BotImportSourceError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Never open the live database: copy it (plus wal/shm) to a temp dir first.
  const tempDir = yield* fileSystem.makeTempDirectory();
  const rows = yield* Effect.gen(function* () {
    for (const suffix of ["", "-wal", "-shm"]) {
      const copy = yield* fileSystem
        .copyFile(dbPath + suffix, path.join(tempDir, `openbot.db${suffix}`))
        .pipe(Effect.result);
      if (suffix === "" && Result.isFailure(copy)) {
        return yield* sourceError("Could not copy the OpenBot database.");
      }
    }
    return yield* Effect.try({
      try: () => readOpenBotData(path.join(tempDir, "openbot.db")),
      catch: (cause) =>
        new BotImportSourceError({ message: `Could not read the OpenBot database. ${cause}` }),
    });
  }).pipe(Effect.ensuring(fileSystem.remove(tempDir, { recursive: true }).pipe(Effect.ignore)));

  const bots: ScannedBot[] = [];
  for (const { agent, memories, routines } of rows) {
    const warnings: string[] = [];
    const workspacePath = agent.workspacePath;
    const instructions =
      workspacePath === undefined
        ? ""
        : ((yield* readTextFile(path.join(workspacePath, "AGENTS.md"))) ?? "");
    if (agent.reasoningEffort !== undefined && agent.reasoningEffort !== "") {
      warnings.push("Thinking level was not carried over.");
    }
    const memory = memories.map((text) => `- ${text}`).join("\n");
    const automations = routines.map((routine) => {
      const { schedule, label, importable } = openbotSchedule(
        routine.scheduleJson,
        routine.timezone,
        warnings,
      );
      if (!importable) {
        warnings.push(`Routine "${routine.name}" was skipped: ${label.toLowerCase()}.`);
      }
      return {
        name: routine.name,
        prompt: routine.instruction,
        schedule,
        scheduleLabel: label,
        importable,
      };
    });
    const skills =
      workspacePath === undefined
        ? []
        : yield* readSkills([
            path.join(workspacePath, ".agents", "skills"),
            path.join(workspacePath, ".claude", "skills"),
          ]);
    const clippedName = clipProfileField(agent.name ?? humanize(agent.id), 100);
    if (clippedName.warning !== undefined) warnings.push(`Name ${clippedName.warning}`);
    // OpenBot keeps an agent's standing instructions in `description`;
    // `title` is its one-line tagline, which becomes our description.
    const clippedDescription = clipProfileField(agent.title, 1000);
    if (clippedDescription.warning !== undefined)
      warnings.push(`Description ${clippedDescription.warning}`);
    const soulParts: string[] = [];
    if (agent.description !== undefined && agent.description.trim().length > 0) {
      soulParts.push(agent.description.trim());
    }
    if (instructions.length > 0) soulParts.push(instructions);
    bots.push({
      key: agent.id,
      name: clippedName.value ?? humanize(agent.id),
      role: undefined,
      description: clippedDescription.value,
      avatar:
        agent.avatarHue === undefined || agent.avatarHue === null
          ? botAvatarOrDefault({ id: agent.id })
          : {
              shape: botAvatarOrDefault({ id: agent.id }).shape,
              color: closestAvatarColor(agent.avatarHue),
            },
      sourceProvider: agent.provider,
      sourceModelSlug: agent.model,
      sourceModel:
        agent.model === undefined
          ? undefined
          : agent.provider === undefined
            ? agent.model
            : `${agent.model} (${agent.provider})`,
      approvalMode: agent.access === "full" ? "full" : "ask",
      interactionMode: undefined,
      limits: undefined,
      soul: cutSoul(soulParts.join("\n\n"), warnings),
      memory: cutMemory(memory, warnings),
      skills,
      automations,
      warnings,
    });
  }
  if (bots.length === 0) {
    return yield* sourceError("The OpenBot database has no agents to import.");
  }
  return { sourceLabel: "OpenBot", bots, warnings: [] };
});

const scheduleLabel = (schedule: ScheduledTaskUpsertSchedule | undefined): string => {
  if (schedule === undefined) return "Unsupported schedule";
  switch (schedule.type) {
    case "interval":
      return `Every ${Math.round(schedule.everyMs / 60_000)} min`;
    case "fixed_time":
      return schedule.weekdays === undefined
        ? `Daily at ${schedule.timeOfDay}`
        : `At ${schedule.timeOfDay} on ${schedule.weekdays.length === 7 ? "every day" : `${schedule.weekdays.length} day(s)`}`;
    case "once":
      return `Once at ${schedule.runAt}`;
    default:
      return "Unsupported schedule";
  }
};

// OpenMausBot keeps its data under ~/.openmausbot (or ~/.opengrokbot on older
// installs, or OMB_DATA_DIR). We read bots.json, routines.json, SOUL.md
// mirrors and workspace memory only: config.json, secrets files, keychain
// stores and memory-journal/ hold credentials and are never opened.
const openMausBotDataDir = Effect.fnUntraced(function* () {
  const home = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  const fileSystem = yield* FileSystem.FileSystem;
  if (env.OMB_DATA_DIR !== undefined && env.OMB_DATA_DIR.trim() !== "") {
    return env.OMB_DATA_DIR;
  }
  for (const dir of [`${home}/.openmausbot`, `${home}/.opengrokbot`]) {
    if (yield* fileSystem.exists(dir).pipe(Effect.orElseSucceed(() => false))) return dir;
  }
  return `${home}/.openmausbot`;
});

interface OpenMausBotRecord {
  readonly id: string;
  readonly name?: string;
  readonly title?: string;
  readonly description?: string;
  readonly soul?: string;
  readonly color?: string;
  readonly approvalMode?: string;
  readonly modelSelection?: { instanceId?: string; model?: string };
}

interface OpenMausBotRoutine {
  readonly name?: string;
  readonly prompt?: string;
  readonly target?: string;
  readonly botId?: string;
  readonly runOn?: string;
  readonly schedule?: {
    type?: string;
    expression?: string;
    at?: number;
    time?: string;
    weekdays?: number[];
    everyMinutes?: number;
    window?: { start: string; end: string };
  };
}

// OpenMausBot palette names onto our eight avatar colors.
const OPENMAUSBOT_COLORS: Readonly<Record<string, string>> = {
  green: "#00d47e",
  blue: "#3b82f6",
  yellow: "#f59e0b",
  orange: "#f59e0b",
  amber: "#f59e0b",
  purple: "#a855f7",
  violet: "#a855f7",
  pink: "#ec4899",
  teal: "#06b6d4",
  cyan: "#06b6d4",
  red: "#ef4444",
  lime: "#84cc16",
};

const openMausBotSchedule = (
  schedule: OpenMausBotRoutine["schedule"],
): { schedule: ScheduledTaskUpsertSchedule | undefined; label: string; importable: boolean } => {
  if (schedule === undefined || typeof schedule.type !== "string") {
    return { schedule: undefined, label: "No schedule", importable: false };
  }
  if (schedule.type === "daily" && typeof schedule.time === "string") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
      return { schedule: undefined, label: "Unsupported schedule (daily)", importable: false };
    }
    const weekdays =
      schedule.weekdays === undefined
        ? undefined
        : schedule.weekdays.filter((day) => day >= 0 && day <= 6);
    const result: ScheduledTaskUpsertSchedule = {
      type: "fixed_time",
      timeOfDay: schedule.time,
      ...(weekdays === undefined ? {} : { weekdays }),
    };
    return { schedule: result, label: scheduleLabel(result), importable: true };
  }
  if (schedule.type === "once" && typeof schedule.at === "number") {
    const result: ScheduledTaskUpsertSchedule = {
      type: "once",
      runAt: DateTime.formatIso(DateTime.makeUnsafe(schedule.at)),
    };
    return { schedule: result, label: scheduleLabel(result), importable: true };
  }
  if (schedule.type === "interval" && typeof schedule.everyMinutes === "number") {
    if (schedule.weekdays !== undefined || schedule.window !== undefined) {
      return {
        schedule: undefined,
        label: "Unsupported schedule (interval with limits)",
        importable: false,
      };
    }
    const result: ScheduledTaskUpsertSchedule = {
      type: "interval",
      everyMs: Math.round(schedule.everyMinutes * 60_000),
    };
    return { schedule: result, label: scheduleLabel(result), importable: true };
  }
  return {
    schedule: undefined,
    label: `Unsupported schedule (${schedule.type})`,
    importable: false,
  };
};

// Exported for tests, which point it at a fixture data dir.
export const scanOpenMausBotDir = Effect.fnUntraced(function* (
  dataDir: string,
): Effect.fn.Return<
  ScannedSource,
  BotImportSourceError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fileSystem.exists(dataDir).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* sourceError("OpenMausBot was not found on this computer.");
  }
  const formatText = yield* readTextFile(path.join(dataDir, "data-format.json"));
  if (formatText !== undefined) {
    const format = (() => {
      try {
        return JSON.parse(formatText) as { format?: unknown };
      } catch {
        return undefined;
      }
    })();
    if (typeof format?.format === "number" && format.format > 2) {
      return yield* sourceError("This OpenMausBot data is newer than SimplyCode can read.");
    }
  }
  const botsText = yield* readTextFile(path.join(dataDir, "bots.json"));
  if (botsText === undefined) {
    return yield* sourceError("OpenMausBot was not found on this computer.");
  }
  const records = (() => {
    try {
      const parsed: unknown = JSON.parse(botsText);
      return Array.isArray(parsed) ? (parsed as ReadonlyArray<OpenMausBotRecord>) : undefined;
    } catch {
      return undefined;
    }
  })();
  if (records === undefined) {
    return yield* sourceError("The OpenMausBot bots.json could not be read.");
  }
  const routinesText = yield* readTextFile(path.join(dataDir, "routines.json"));
  const routines = ((): ReadonlyArray<OpenMausBotRoutine> => {
    if (routinesText === undefined) return [];
    try {
      const parsed = JSON.parse(routinesText) as { routines?: unknown };
      return Array.isArray(parsed.routines)
        ? (parsed.routines as ReadonlyArray<OpenMausBotRoutine>)
        : [];
    } catch {
      return [];
    }
  })();

  const bots: ScannedBot[] = [];
  for (const record of records) {
    if (typeof record.id !== "string" || record.id.length === 0) continue;
    const warnings: string[] = [];
    const workspace = path.join(dataDir, "workspaces", record.id);
    const soulMirror = yield* readTextFile(path.join(dataDir, "bots", record.id, "SOUL.md"));
    const soul = record.soul ?? soulMirror ?? "";

    // Memory is MEMORY.md plus each top-level topic file under memory/.
    const memoryParts: string[] = [];
    const indexText = yield* readTextFile(path.join(workspace, "MEMORY.md"));
    if (indexText !== undefined && indexText.trim().length > 0) memoryParts.push(indexText);
    const memoryDir = path.join(workspace, "memory");
    const memoryEntries = yield* fileSystem.readDirectory(memoryDir).pipe(Effect.result);
    if (Result.isSuccess(memoryEntries)) {
      for (const entry of memoryEntries.success.toSorted()) {
        if (!entry.endsWith(".md")) continue;
        const info = yield* fileSystem.stat(path.join(memoryDir, entry)).pipe(Effect.result);
        if (Result.isFailure(info) || info.success.type !== "File") continue;
        const topic = yield* readTextFile(path.join(memoryDir, entry));
        if (topic === undefined) continue;
        memoryParts.push(`## ${entry.slice(0, -".md".length)}\n\n${topic}`);
      }
    }

    const automations = routines
      .filter((routine) => routine.target === "bot" && routine.botId === record.id)
      .map((routine) => {
        const name = routine.name ?? "Routine";
        if (routine.runOn === "cloud") {
          warnings.push(`Routine "${name}" was skipped: runs on a cloud computer.`);
          return {
            name,
            prompt: routine.prompt ?? "",
            schedule: undefined,
            scheduleLabel: "Runs on a cloud computer",
            importable: false,
          };
        }
        const { schedule, label, importable } = openMausBotSchedule(routine.schedule);
        if (!importable) {
          warnings.push(`Routine "${name}" was skipped: ${label.toLowerCase()}.`);
        }
        return {
          name,
          prompt: routine.prompt ?? "",
          schedule,
          scheduleLabel: label,
          importable,
        };
      });

    const skills = yield* readSkills([
      path.join(workspace, ".agents", "skills"),
      path.join(workspace, ".claude", "skills"),
      path.join(workspace, "skills"),
    ]);

    const clippedName = clipProfileField(record.name ?? humanize(record.id), 100);
    if (clippedName.warning !== undefined) warnings.push(`Name ${clippedName.warning}`);
    const clippedRole = clipProfileField(record.title, 60);
    if (clippedRole.warning !== undefined) warnings.push(`Role ${clippedRole.warning}`);
    const clippedDescription = clipProfileField(record.description, 1000);
    if (clippedDescription.warning !== undefined)
      warnings.push(`Description ${clippedDescription.warning}`);

    const approvalMode: BotApprovalMode = record.approvalMode === "full" ? "full" : "ask";
    if (record.approvalMode === undefined) {
      warnings.push("No approval mode was stored; it was set to ask.");
    } else if (record.approvalMode !== "full" && record.approvalMode !== "ask") {
      warnings.push(
        `Approval mode "${record.approvalMode}" is not available here; it was set to ask.`,
      );
    }

    const color = record.color === undefined ? undefined : OPENMAUSBOT_COLORS[record.color];
    bots.push({
      key: record.id,
      name: clippedName.value ?? humanize(record.id),
      role: clippedRole.value,
      description: clippedDescription.value,
      avatar:
        color === undefined
          ? botAvatarOrDefault({ id: record.id })
          : {
              shape: botAvatarOrDefault({ id: record.id }).shape,
              color,
            },
      sourceProvider: record.modelSelection?.instanceId,
      sourceModelSlug: record.modelSelection?.model,
      sourceModel:
        record.modelSelection?.model === undefined
          ? undefined
          : `${record.modelSelection.model} (${record.modelSelection.instanceId ?? "unknown"})`,
      approvalMode,
      interactionMode: undefined,
      limits: undefined,
      soul: cutSoul(soul, warnings),
      memory: cutMemory(memoryParts.join("\n\n"), warnings),
      skills,
      automations,
      warnings,
    });
  }
  if (bots.length === 0) {
    return yield* sourceError("The OpenMausBot data folder has no bots to import.");
  }
  return { sourceLabel: "OpenMausBot", bots, warnings: [] };
});

const scanOpenMausBot = Effect.fnUntraced(function* () {
  return yield* scanOpenMausBotDir(yield* openMausBotDataDir());
});

const PackageFile = Schema.Union([
  Schema.Struct({ path: Schema.String, text: Schema.String }),
  Schema.Struct({ path: Schema.String, base64: Schema.String }),
]);

const PackageBot = Schema.Struct({
  profile: Schema.Struct({
    name: Schema.String,
    avatar: Schema.optional(Schema.Struct({ shape: Schema.String, color: Schema.String })),
    role: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    modelSelection: Schema.optional(
      Schema.Struct({
        instanceId: Schema.String,
        model: Schema.String,
        options: Schema.optional(Schema.Unknown),
      }),
    ),
    approvalMode: Schema.optional(Schema.String),
    interactionMode: Schema.optional(Schema.String),
    limits: Schema.optional(Schema.Unknown),
    canManageBots: Schema.optional(Schema.Boolean),
  }),
  soul: Schema.optional(Schema.String),
  memory: Schema.optional(Schema.String),
  skills: Schema.Array(
    Schema.Struct({ name: Schema.String, files: Schema.Array(PackageFile) }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  automations: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      prompt: Schema.String,
      schedule: Schema.Unknown,
    }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
});

const BotPackageSchema = Schema.Struct({
  format: Schema.Literal("simplycode-bots"),
  version: Schema.Literal(1),
  exportedAt: Schema.optional(Schema.String),
  bots: Schema.Array(PackageBot),
});
type BotPackage = typeof BotPackageSchema.Type;

const decodePackage = Schema.decodeUnknownSync(BotPackageSchema);
const isBotAvatar = Schema.is(BotAvatar);
const decodeApproval = Schema.decodeUnknownOption(BotApprovalMode);
const decodeInteraction = Schema.decodeUnknownOption(ProviderInteractionMode);
const decodeSchedule = Schema.decodeUnknownOption(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("interval"),
      everyMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(60_000)),
    }),
    Schema.Struct({
      type: Schema.Literal("fixed_time"),
      timeOfDay: Schema.String,
      weekdays: Schema.optional(
        Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
      ),
    }),
    Schema.Struct({ type: Schema.Literal("once"), runAt: Schema.String }),
  ]),
);
const decodeLimits = Schema.decodeUnknownOption(
  Schema.Struct({
    maxStepsPerRun: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    maxCostUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
  }),
);

const isSafeSkillPath = (filePath: string): boolean =>
  filePath.length > 0 &&
  !filePath.startsWith("/") &&
  !filePath.includes("\\") &&
  !/^[a-zA-Z]:/.test(filePath) &&
  !filePath.split("/").some((segment) => segment === ".." || segment === "");

const parsePackage = (content: string): BotPackage | undefined => {
  try {
    return decodePackage(JSON.parse(content));
  } catch {
    return undefined;
  }
};

export const scanFolderSource = scanFolder;

const scanPackage = Effect.fnUntraced(function* (
  content: string,
): Effect.fn.Return<ScannedSource, BotImportSourceError> {
  if (Buffer.byteLength(content, "utf8") > PACKAGE_MAX_BYTES) {
    return yield* sourceError("The file is larger than 10 MB.");
  }
  const decoded = parsePackage(content);
  if (decoded === undefined) {
    return yield* sourceError("The file is not a SimplyCode bots package.");
  }
  const warnings: string[] = [];
  const bots: ScannedBot[] = [];
  decoded.bots.forEach((bot, index) => {
    const botWarnings: string[] = [];
    const bad = bot.skills.some((skill) => skill.files.some((file) => !isSafeSkillPath(file.path)));
    if (bad) {
      warnings.push(
        `"${bot.profile.name || `bot ${index + 1}`}" was rejected: a skill file path is unsafe.`,
      );
      return;
    }
    const skills = bot.skills.map((skill) => ({
      name: skill.name,
      files: skill.files.map((file) => ({
        path: file.path,
        data:
          "base64" in file ? Buffer.from(file.base64, "base64") : Buffer.from(file.text, "utf8"),
      })),
    }));
    const automations = bot.automations.map((automation) => {
      const schedule = decodeSchedule(automation.schedule);
      const importable = schedule._tag === "Some";
      if (!importable) {
        botWarnings.push(`Routine "${automation.name}" was skipped: unsupported schedule.`);
      }
      return {
        name: automation.name,
        prompt: automation.prompt,
        schedule: schedule._tag === "Some" ? schedule.value : undefined,
        scheduleLabel: scheduleLabel(schedule._tag === "Some" ? schedule.value : undefined),
        importable,
      };
    });
    const name = bot.profile.name.trim();
    if (name.length === 0) {
      warnings.push(`A bot with no name was skipped.`);
      return;
    }
    // Imported bots never arrive as managers; the flag is opt-in per bot.
    if (bot.profile.canManageBots === true) {
      botWarnings.push(
        `Bot management was not carried over. Turn on "Can create and edit other bots" in the bot's profile to keep it.`,
      );
    }
    const approvalMode = decodeApproval(bot.profile.approvalMode);
    const interactionMode = decodeInteraction(bot.profile.interactionMode);
    const limits = decodeLimits(bot.profile.limits);
    const avatar = isBotAvatar(bot.profile.avatar) ? bot.profile.avatar : undefined;
    const sourceModel = bot.profile.modelSelection;
    bots.push({
      key: `bot-${index}`,
      name: name.slice(0, 100),
      role:
        bot.profile.role === undefined || bot.profile.role === ""
          ? undefined
          : bot.profile.role.slice(0, 60),
      description:
        bot.profile.description === "" ? undefined : bot.profile.description?.slice(0, 1000),
      avatar,
      sourceProvider: sourceModel?.instanceId,
      sourceModelSlug: sourceModel?.model,
      sourceModel:
        sourceModel === undefined ? undefined : `${sourceModel.model} (${sourceModel.instanceId})`,
      approvalMode: approvalMode._tag === "Some" ? approvalMode.value : "ask",
      interactionMode: interactionMode._tag === "Some" ? interactionMode.value : undefined,
      limits: limits._tag === "Some" ? limits.value : undefined,
      soul: cutSoul(bot.soul ?? "", botWarnings),
      memory: cutMemory(bot.memory ?? "", botWarnings),
      skills,
      automations,
      warnings: botWarnings,
    });
  });
  return { sourceLabel: "SimplyCode package", bots, warnings };
});

export const scanSource = (
  source: BotImportSource,
): Effect.Effect<
  ScannedSource,
  BotImportSourceError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> => {
  switch (source.type) {
    case "openbot":
      return scanOpenBot();
    case "openmausbot":
      return scanOpenMausBot();
    case "folder":
      return scanFolder(source.path);
    case "package":
      return scanPackage(source.content);
  }
};
