// Bot profiles live as folders under `bots/` in the server home, one `bot.json`
// plus an optional `SOUL.md` per bot, watched so edits land without a restart.
// A folder that cannot be read keeps the last good list rather than looking
// like every bot was deleted.
import {
  Bot,
  BOT_MEMORY_MAX_BYTES,
  BOT_SOUL_MAX_BYTES,
  BotError,
  BotId,
  BotProfile,
  BotSkillName,
  botThreadTag,
  normalizeBotSkillName,
  type BotLoadError,
  type BotListResult,
  type BotSkill,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";

const WATCH_SETTLE = Duration.millis(100);
const PROFILE_FILE = "bot.json";
const SOUL_FILE = "SOUL.md";
const MEMORY_FILE = "MEMORY.md";
const SKILLS_DIR = "skills";
const SKILL_FILE = "SKILL.md";
const SKILL_MAX_FILES = 200;
const SKILL_MAX_BYTES = 2 * 1024 * 1024;
const MEMORY_OVER_LIMIT_NOTE =
  "\n\n(Memory is over its 16 KB limit and was cut off here. Condense it with update_bot_memory in replace mode.)";

// Cuts to maxBytes on a code-point boundary so a bot that wrote past the cap
// still loads; the bot's own tool can then rewrite the file within the limit.
const truncateMemoryToLimit = (memory: string): string => {
  const bytes = Buffer.from(memory, "utf8");
  if (bytes.length <= BOT_MEMORY_MAX_BYTES) return memory;
  let end = BOT_MEMORY_MAX_BYTES;
  // buf[end] is the byte after the cut; stepping back off continuation bytes
  // (10xxxxxx) leaves the slice ending at a code-point boundary.
  while (end > 0 && ((bytes.at(end) ?? 0) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + MEMORY_OVER_LIMIT_NOTE;
};

/** A skill on disk: its wire fields plus the absolute SKILL.md path for prompts. */
export interface BotInstalledSkill extends BotSkill {
  readonly path: string;
}

interface BotState {
  readonly bots: ReadonlyMap<BotId, Bot>;
  readonly souls: ReadonlyMap<BotId, string>;
  readonly memories: ReadonlyMap<BotId, string>;
  readonly skills: ReadonlyMap<BotId, ReadonlyArray<BotInstalledSkill>>;
  readonly loadErrors: ReadonlyArray<BotLoadError>;
}

const EMPTY: BotState = {
  bots: new Map(),
  souls: new Map(),
  memories: new Map(),
  skills: new Map(),
  loadErrors: [],
};

const decodeBotId = Schema.decodeUnknownOption(BotId);
const decodeBotSkillName = Schema.decodeUnknownOption(BotSkillName);
const decodeProfile = Schema.decodeUnknownEffect(BotProfile);

// A profile is a schema-decoded plain object, so these cannot throw on valid
// data; kept outside Effect generators where JSON must fail typed.
const parseProfileJson = (raw: string): unknown | undefined => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

// Profiles written before avatars became structured carry a string; treat it as unset.
const normalizeProfile = (parsed: unknown): unknown => {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return parsed;
  const { avatar, ...rest } = parsed as Record<string, unknown>;
  if (avatar !== undefined && typeof avatar !== "object") return rest;
  return parsed;
};
const profileJson = (profile: BotProfile) => `${JSON.stringify(profile, null, 2)}\n`;

// The description lives in SKILL.md frontmatter as a single `description:` line.
const skillDescription = (text: string): string | undefined => {
  if (!text.startsWith("---")) return undefined;
  const end = text.indexOf("\n---", 3);
  const frontmatter = end === -1 ? text : text.slice(0, end);
  const value = /^description:[ \t]*(.+?)[ \t]*$/m.exec(frontmatter)?.[1];
  if (value === undefined) return undefined;
  // Unwrap YAML `"…"`/`'…'` scalars and collapse double-quoted `\n` escapes.
  const unquoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
      ? value.slice(1, -1).replace(/\\n/g, " ")
      : value;
  const cleaned = unquoted.trim();
  return cleaned.length === 0 ? undefined : cleaned;
};

function slugifyBotName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "bot";
}

export class BotStore extends Context.Service<
  BotStore,
  {
    readonly list: () => Effect.Effect<BotListResult>;
    readonly subscribeList: () => Stream.Stream<BotListResult>;
    readonly find: (id: BotId) => Effect.Effect<Bot | undefined>;
    readonly get: (id: BotId) => Effect.Effect<
      {
        bot: Bot;
        soul: string;
        memory: string;
        skills: ReadonlyArray<BotInstalledSkill>;
        skillsDir: string;
      },
      BotError
    >;
    readonly write: (
      profile: BotProfile,
      soul?: string,
      memory?: string,
    ) => Effect.Effect<Bot, BotError>;
    /** Writes MEMORY.md only; an empty string deletes it. Returns the new size. */
    readonly writeMemory: (id: BotId, memory: string) => Effect.Effect<number, BotError>;
    readonly remove: (id: BotId) => Effect.Effect<void, BotError>;
    /**
     * Copies a skill into `skills/<slug>/`. `sourcePath` is a SKILL.md file or a
     * folder that contains one.
     */
    readonly installSkill: (id: BotId, sourcePath: string) => Effect.Effect<Bot, BotError>;
    /**
     * Writes `files` (relative `/` paths, already path-checked by the caller)
     * into `skills/<name>/` through a staging dir, under the same checks as
     * `installSkill`.
     */
    readonly installSkillFiles: (
      id: BotId,
      name: BotSkillName,
      files: ReadonlyArray<{ readonly path: string; readonly data: Uint8Array }>,
    ) => Effect.Effect<Bot, BotError>;
    readonly removeSkill: (id: BotId, name: BotSkillName) => Effect.Effect<Bot, BotError>;
    readonly allocateId: (name: string) => Effect.Effect<BotId>;
    /** The bot's soul text for prompt assembly; empty when absent. */
    readonly soul: (id: BotId) => Effect.Effect<string | undefined>;
    /** Completes once the folder watcher is registered (or has failed to be). */
    readonly watchReady: Effect.Effect<void>;
  }
>()("simplycode/bots/BotStore") {}

function botError(message: string, input?: { botId?: BotId; cause?: unknown }) {
  return new BotError({
    message,
    ...(input?.botId === undefined ? {} : { botId: input.botId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

export const layer = Layer.effect(
  BotStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = config.botsDir;
    const state = yield* SubscriptionRef.make<BotState>(EMPTY);
    const scope = yield* Effect.scope;

    const profilePath = (id: string) => path.join(directory, id, PROFILE_FILE);
    const soulPath = (id: string) => path.join(directory, id, SOUL_FILE);
    const memoryPath = (id: string) => path.join(directory, id, MEMORY_FILE);
    const skillsDir = (id: string) => path.join(directory, id, SKILLS_DIR);

    const readFolder = Effect.fnUntraced(function* (
      folder: string,
    ): Effect.fn.Return<
      | { bot: Bot; soul: string; memory: string; skills: ReadonlyArray<BotInstalledSkill> }
      | BotLoadError
      | undefined,
      never
    > {
      const info = yield* fileSystem.stat(path.join(directory, folder)).pipe(Effect.result);
      if (Result.isFailure(info) || info.success.type !== "Directory") return undefined;
      const raw = yield* fileSystem
        .readFileString(path.join(directory, folder, PROFILE_FILE))
        .pipe(Effect.result);
      if (Result.isFailure(raw)) {
        return { folder, message: `${PROFILE_FILE} could not be read.` };
      }
      const parsed = parseProfileJson(raw.success);
      if (parsed === undefined) {
        return { folder, message: `${PROFILE_FILE} is not valid JSON.` };
      }
      const profile = yield* decodeProfile(normalizeProfile(parsed)).pipe(
        Effect.mapError((error) => ({
          folder,
          message: `${PROFILE_FILE} is not a valid bot profile: ${String(error.message)}`,
        })),
        Effect.result,
      );
      if (Result.isFailure(profile)) return profile.failure;
      if (profile.success.id !== folder) {
        return { folder, message: `${PROFILE_FILE} id does not match the folder name.` };
      }
      const soulRaw = yield* fileSystem
        .readFileString(path.join(directory, folder, SOUL_FILE))
        .pipe(Effect.result);
      const soul = Result.isSuccess(soulRaw) ? soulRaw.success : "";
      const soulBytes = Buffer.byteLength(soul, "utf8");
      if (soulBytes > BOT_SOUL_MAX_BYTES) {
        return { folder, message: `${SOUL_FILE} exceeds the 24 KB limit.` };
      }
      const memoryRaw = yield* fileSystem
        .readFileString(path.join(directory, folder, MEMORY_FILE))
        .pipe(Effect.result);
      const memoryFull = Result.isSuccess(memoryRaw) ? memoryRaw.success : "";
      const memoryBytes = Buffer.byteLength(memoryFull, "utf8");
      const memory = truncateMemoryToLimit(memoryFull);
      const skills: Array<BotInstalledSkill> = [];
      const skillEntries = yield* fileSystem
        .readDirectory(path.join(directory, folder, SKILLS_DIR))
        .pipe(Effect.result);
      if (Result.isSuccess(skillEntries)) {
        for (const entry of skillEntries.success.toSorted()) {
          const skillDir = path.join(directory, folder, SKILLS_DIR, entry);
          const entryInfo = yield* fileSystem.stat(skillDir).pipe(Effect.result);
          if (Result.isFailure(entryInfo) || entryInfo.success.type !== "Directory") continue;
          const name = decodeBotSkillName(entry);
          if (name._tag === "None") continue;
          const skillFile = path.join(skillDir, SKILL_FILE);
          const skillText = yield* fileSystem.readFileString(skillFile).pipe(Effect.result);
          if (Result.isFailure(skillText)) continue;
          const description = skillDescription(skillText.success);
          skills.push({
            name: name.value,
            ...(description === undefined ? {} : { description }),
            path: skillFile,
          });
        }
      }
      return {
        bot: {
          ...profile.success,
          soulBytes,
          memoryBytes,
          skills: skills.map(({ path: _path, ...skill }) => skill),
          threadTag: botThreadTag(profile.success.id),
        },
        soul,
        memory,
        skills,
      };
    });

    // Undefined means the folder could not be read at all: keep the last good state.
    const readAll: Effect.Effect<BotState | undefined> = Effect.gen(function* () {
      const entries = yield* fileSystem.readDirectory(directory).pipe(
        Effect.map((names) => names.toSorted()),
        Effect.result,
      );
      if (Result.isFailure(entries)) return undefined;
      const bots = new Map<BotId, Bot>();
      const souls = new Map<BotId, string>();
      const memories = new Map<BotId, string>();
      const skills = new Map<BotId, ReadonlyArray<BotInstalledSkill>>();
      const loadErrors: Array<BotLoadError> = [];
      for (const folder of entries.success) {
        const read = yield* readFolder(folder);
        if (read === undefined) continue;
        if ("message" in read) {
          loadErrors.push(read);
          continue;
        }
        bots.set(read.bot.id, read.bot);
        souls.set(read.bot.id, read.soul);
        memories.set(read.bot.id, read.memory);
        skills.set(read.bot.id, read.skills);
      }
      return { bots, souls, memories, skills, loadErrors };
    });

    const reload = Effect.suspend(() =>
      readAll.pipe(
        Effect.flatMap((next) =>
          next === undefined
            ? Effect.logWarning(`${directory} could not be read; keeping the last good bot list`)
            : SubscriptionRef.set(state, next),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Reloading bot profiles failed", Cause.pretty(cause)),
        ),
      ),
    );

    yield* Effect.ignore(fileSystem.makeDirectory(directory, { recursive: true }));
    yield* reload;

    const watcherReady = yield* Deferred.make<void>();
    const markWatcherReady = () => Deferred.doneUnsafe(watcherReady, Exit.void);
    yield* fileSystem.watch(directory, { recursive: true, onReady: markWatcherReady }).pipe(
      Stream.debounce(WATCH_SETTLE),
      Stream.runForEach(() => reload),
      Effect.catchCause((cause) =>
        Effect.logWarning("Bot profiles are not watched for changes", Cause.pretty(cause)),
      ),
      Effect.ensuring(Effect.sync(markWatcherReady)),
      Effect.forkIn(scope),
    );

    const writeFileAtomic = Effect.fnUntraced(function* (target: string, content: string) {
      const tmp = `${target}.tmp-${process.pid}`;
      yield* fileSystem.writeFileString(tmp, content);
      yield* fileSystem.rename(tmp, target);
    });

    const list: BotStore["Service"]["list"] = Effect.fn("BotStore.list")(function* () {
      const current = yield* SubscriptionRef.get(state);
      return {
        bots: [...current.bots.values()],
        loadErrors: [...current.loadErrors],
      } satisfies BotListResult;
    });

    const find: BotStore["Service"]["find"] = Effect.fn("BotStore.find")(function* (id) {
      const current = yield* SubscriptionRef.get(state);
      return current.bots.get(id);
    });

    const get: BotStore["Service"]["get"] = Effect.fn("BotStore.get")(function* (id) {
      const current = yield* SubscriptionRef.get(state);
      const bot = current.bots.get(id);
      if (bot === undefined) return yield* botError("Bot not found.", { botId: id });
      return {
        bot,
        soul: current.souls.get(id) ?? "",
        memory: current.memories.get(id) ?? "",
        skills: current.skills.get(id) ?? [],
        skillsDir: skillsDir(id),
      };
    });

    const write: BotStore["Service"]["write"] = Effect.fn("BotStore.write")(
      function* (profile, soul, memory) {
        const dir = path.join(directory, profile.id);
        yield* fileSystem
          .makeDirectory(dir, { recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              botError("Could not create the bot folder.", { botId: profile.id, cause }),
            ),
          );
        yield* writeFileAtomic(profilePath(profile.id), profileJson(profile)).pipe(
          Effect.mapError((cause) =>
            botError("Could not write the bot profile.", { botId: profile.id, cause }),
          ),
        );
        if (soul !== undefined) {
          if (soul.length === 0) {
            yield* fileSystem.remove(soulPath(profile.id)).pipe(Effect.ignore);
          } else {
            yield* writeFileAtomic(soulPath(profile.id), soul).pipe(
              Effect.mapError((cause) =>
                botError("Could not write the bot soul.", { botId: profile.id, cause }),
              ),
            );
          }
        }
        if (memory !== undefined) {
          if (memory.length === 0) {
            yield* fileSystem.remove(memoryPath(profile.id)).pipe(Effect.ignore);
          } else {
            yield* writeFileAtomic(memoryPath(profile.id), memory).pipe(
              Effect.mapError((cause) =>
                botError("Could not write the bot memory.", { botId: profile.id, cause }),
              ),
            );
          }
        }
        yield* reload;
        const written = yield* find(profile.id);
        return (
          written ?? {
            ...profile,
            soulBytes: 0,
            memoryBytes: 0,
            skills: [],
            threadTag: botThreadTag(profile.id),
          }
        );
      },
    );

    const writeMemory: BotStore["Service"]["writeMemory"] = Effect.fn("BotStore.writeMemory")(
      function* (id, memory) {
        const memoryBytes = Buffer.byteLength(memory, "utf8");
        if (memoryBytes > BOT_MEMORY_MAX_BYTES) {
          return yield* botError(`Memory exceeds the 16 KB limit.`, { botId: id });
        }
        const current = yield* SubscriptionRef.get(state);
        if (!current.bots.has(id)) {
          return yield* botError("Bot not found.", { botId: id });
        }
        if (memory.length === 0) {
          yield* fileSystem.remove(memoryPath(id)).pipe(Effect.ignore);
        } else {
          yield* writeFileAtomic(memoryPath(id), memory).pipe(
            Effect.mapError((cause) =>
              botError("Could not write the bot memory.", { botId: id, cause }),
            ),
          );
        }
        yield* reload;
        return memoryBytes;
      },
    );

    const remove: BotStore["Service"]["remove"] = Effect.fn("BotStore.remove")(function* (id) {
      yield* fileSystem
        .remove(path.join(directory, id), { recursive: true })
        .pipe(
          Effect.mapError((cause) => botError("Could not delete the bot.", { botId: id, cause })),
        );
      yield* reload;
    });

    // Everything is checked before a single byte is copied: links, the file
    // count, and the total size.
    const checkSkillSource = Effect.fnUntraced(function* (root: string, botId: BotId) {
      let files = 0;
      let bytes = 0;
      const pending = [root];
      while (pending.length > 0) {
        const dir = pending.pop()!;
        const entries = yield* fileSystem
          .readDirectory(dir)
          .pipe(
            Effect.mapError((cause) => botError("Could not read the skill.", { botId, cause })),
          );
        for (const entry of entries) {
          const full = path.join(dir, entry);
          const info = yield* fileSystem
            .lstat(full)
            .pipe(
              Effect.mapError((cause) => botError("Could not read the skill.", { botId, cause })),
            );
          if (info.type === "SymbolicLink") {
            return yield* botError(`The skill contains a symbolic link: ${entry}.`, { botId });
          }
          if (info.type === "Directory") {
            pending.push(full);
            continue;
          }
          files += 1;
          bytes += Number(info.size);
          if (files > SKILL_MAX_FILES) {
            return yield* botError("The skill has more than 200 files.", { botId });
          }
          if (bytes > SKILL_MAX_BYTES) {
            return yield* botError("The skill is larger than 2 MB.", { botId });
          }
        }
      }
    });

    const copyDirectory = Effect.fnUntraced(function* (
      from: string,
      to: string,
      botId: BotId,
    ): Effect.fn.Return<void, BotError> {
      yield* fileSystem
        .makeDirectory(to, { recursive: true })
        .pipe(Effect.mapError((cause) => botError("Could not copy the skill.", { botId, cause })));
      const entries = yield* fileSystem
        .readDirectory(from)
        .pipe(Effect.mapError((cause) => botError("Could not copy the skill.", { botId, cause })));
      for (const entry of entries) {
        const src = path.join(from, entry);
        const dst = path.join(to, entry);
        const info = yield* fileSystem
          .lstat(src)
          .pipe(
            Effect.mapError((cause) => botError("Could not copy the skill.", { botId, cause })),
          );
        if (info.type === "Directory") {
          yield* copyDirectory(src, dst, botId);
        } else {
          yield* fileSystem
            .copyFile(src, dst)
            .pipe(
              Effect.mapError((cause) => botError("Could not copy the skill.", { botId, cause })),
            );
        }
      }
    });

    // Swaps a fully populated staging dir onto `skills/<slug>/` and reloads.
    const swapStagedSkill = Effect.fnUntraced(function* (id: BotId, slug: string, staging: string) {
      const current = yield* SubscriptionRef.get(state);
      const target = path.join(skillsDir(id), slug);
      yield* fileSystem.remove(target, { recursive: true }).pipe(Effect.ignore);
      yield* fileSystem
        .rename(staging, target)
        .pipe(
          Effect.mapError((cause) =>
            botError("Could not install the skill.", { botId: id, cause }),
          ),
        );
      yield* reload;
      const written = yield* find(id);
      return written ?? { ...current.bots.get(id)!, skills: [] };
    });

    const installSkill: BotStore["Service"]["installSkill"] = Effect.fn("BotStore.installSkill")(
      function* (id, sourcePath) {
        const current = yield* SubscriptionRef.get(state);
        if (!current.bots.has(id)) {
          return yield* botError("Bot not found.", { botId: id });
        }
        const info = yield* fileSystem.stat(sourcePath).pipe(Effect.result);
        let sourceDir: string;
        if (Result.isSuccess(info) && info.success.type === "Directory") {
          sourceDir = sourcePath;
        } else if (
          Result.isSuccess(info) &&
          info.success.type === "File" &&
          path.basename(sourcePath) === SKILL_FILE
        ) {
          sourceDir = path.dirname(sourcePath);
        } else {
          return yield* botError("A skill must be a SKILL.md file or a folder that contains one.", {
            botId: id,
          });
        }
        const contents = yield* fileSystem.readDirectory(sourceDir).pipe(Effect.result);
        if (Result.isFailure(contents) || !contents.success.some((entry) => entry === SKILL_FILE)) {
          return yield* botError("The skill folder does not contain a SKILL.md.", { botId: id });
        }
        // The source folder name becomes the slug after normalization;
        // only a name with no usable characters is rejected.
        const slug = normalizeBotSkillName(path.basename(sourceDir));
        if (slug === undefined) {
          return yield* botError(`"${path.basename(sourceDir)}" is not a valid skill name.`, {
            botId: id,
          });
        }
        yield* checkSkillSource(sourceDir, id);
        // Stage next to the target, then swap, so a failed copy leaves nothing.
        const target = path.join(skillsDir(id), slug);
        const staging = `${target}.tmp-${process.pid}`;
        const copied = yield* copyDirectory(sourceDir, staging, id).pipe(Effect.result);
        if (Result.isFailure(copied)) {
          yield* fileSystem.remove(staging, { recursive: true }).pipe(Effect.ignore);
          return yield* copied.failure;
        }
        return yield* swapStagedSkill(id, slug, staging);
      },
    );

    const installSkillFiles: BotStore["Service"]["installSkillFiles"] = Effect.fn(
      "BotStore.installSkillFiles",
    )(function* (id, name, files) {
      const current = yield* SubscriptionRef.get(state);
      if (!current.bots.has(id)) {
        return yield* botError("Bot not found.", { botId: id });
      }
      if (!files.some((file) => file.path === SKILL_FILE)) {
        return yield* botError("The skill folder does not contain a SKILL.md.", { botId: id });
      }
      const target = path.join(skillsDir(id), name);
      const staging = `${target}.tmp-${process.pid}`;
      const staged = yield* Effect.forEach(
        files,
        (file) => {
          const full = path.join(staging, ...file.path.split("/"));
          return fileSystem
            .makeDirectory(path.dirname(full), { recursive: true })
            .pipe(Effect.andThen(fileSystem.writeFile(full, file.data)));
        },
        { discard: true },
      ).pipe(Effect.result);
      if (Result.isFailure(staged)) {
        yield* fileSystem.remove(staging, { recursive: true }).pipe(Effect.ignore);
        return yield* botError("Could not write the skill files.", {
          botId: id,
          cause: staged.failure,
        });
      }
      const checked = yield* checkSkillSource(staging, id).pipe(Effect.result);
      if (Result.isFailure(checked)) {
        yield* fileSystem.remove(staging, { recursive: true }).pipe(Effect.ignore);
        return yield* checked.failure;
      }
      return yield* swapStagedSkill(id, name, staging);
    });

    const removeSkill: BotStore["Service"]["removeSkill"] = Effect.fn("BotStore.removeSkill")(
      function* (id, name) {
        const current = yield* SubscriptionRef.get(state);
        if (!current.bots.has(id)) {
          return yield* botError("Bot not found.", { botId: id });
        }
        const target = path.join(skillsDir(id), name);
        const exists = yield* fileSystem
          .exists(target)
          .pipe(
            Effect.mapError((cause) =>
              botError("Could not remove the skill.", { botId: id, cause }),
            ),
          );
        if (!exists) {
          return yield* botError("Skill not found.", { botId: id });
        }
        yield* fileSystem
          .remove(target, { recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              botError("Could not remove the skill.", { botId: id, cause }),
            ),
          );
        yield* reload;
        const written = yield* find(id);
        return written ?? { ...current.bots.get(id)!, skills: [] };
      },
    );

    const allocateId: BotStore["Service"]["allocateId"] = Effect.fn("BotStore.allocateId")(
      function* (name) {
        const base = slugifyBotName(name);
        const current = yield* SubscriptionRef.get(state);
        for (let suffix = 0; ; suffix++) {
          const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
          const decoded = decodeBotId(candidate);
          if (decoded._tag === "None") continue;
          if (!current.bots.has(decoded.value)) return decoded.value;
        }
      },
    );

    const soul: BotStore["Service"]["soul"] = Effect.fn("BotStore.soul")(function* (id) {
      const current = yield* SubscriptionRef.get(state);
      return current.souls.get(id);
    });

    return BotStore.of({
      list,
      subscribeList: () =>
        SubscriptionRef.changes(state).pipe(
          Stream.map((current) => ({
            bots: [...current.bots.values()],
            loadErrors: [...current.loadErrors],
          })),
        ),
      find,
      get,
      write,
      writeMemory,
      remove,
      installSkill,
      installSkillFiles,
      removeSkill,
      allocateId,
      soul,
      watchReady: Deferred.await(watcherReady),
    });
  }),
);
