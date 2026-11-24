// Bot profiles live as folders under `bots/` in the server home, one `bot.json`
// plus an optional `SOUL.md` per bot, watched so edits land without a restart.
// A folder that cannot be read keeps the last good list rather than looking
// like every bot was deleted.
import {
  Bot,
  BOT_SOUL_MAX_BYTES,
  BotError,
  BotId,
  BotProfile,
  botThreadTag,
  type BotLoadError,
  type BotListResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
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

interface BotState {
  readonly bots: ReadonlyMap<BotId, Bot>;
  readonly souls: ReadonlyMap<BotId, string>;
  readonly loadErrors: ReadonlyArray<BotLoadError>;
}

const EMPTY: BotState = { bots: new Map(), souls: new Map(), loadErrors: [] };

const decodeBotId = Schema.decodeUnknownOption(BotId);
const decodeProfile = Schema.decodeUnknownEffect(BotProfile);

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
    readonly get: (id: BotId) => Effect.Effect<{ bot: Bot; soul: string }, BotError>;
    readonly write: (profile: BotProfile, soul?: string) => Effect.Effect<Bot, BotError>;
    readonly remove: (id: BotId) => Effect.Effect<void, BotError>;
    readonly allocateId: (name: string) => Effect.Effect<BotId>;
    /** The bot's soul text for prompt assembly; empty when absent. */
    readonly soul: (id: BotId) => Effect.Effect<string | undefined>;
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

    const readFolder = Effect.fnUntraced(function* (
      folder: string,
    ): Effect.fn.Return<{ bot: Bot; soul: string } | BotLoadError | undefined, never> {
      const info = yield* fileSystem.stat(path.join(directory, folder)).pipe(Effect.result);
      if (Result.isFailure(info) || info.success.type !== "Directory") return undefined;
      const raw = yield* fileSystem
        .readFileString(path.join(directory, folder, PROFILE_FILE))
        .pipe(Effect.result);
      if (Result.isFailure(raw)) {
        return { folder, message: `${PROFILE_FILE} could not be read.` };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.success);
      } catch {
        return { folder, message: `${PROFILE_FILE} is not valid JSON.` };
      }
      const profile = yield* decodeProfile(parsed).pipe(
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
      return {
        bot: { ...profile.success, soulBytes, threadTag: botThreadTag(profile.success.id) },
        soul,
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
      }
      return { bots, souls, loadErrors };
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

    yield* fileSystem.watch(directory).pipe(
      Stream.debounce(WATCH_SETTLE),
      Stream.runForEach(() => reload),
      Effect.catchCause((cause) =>
        Effect.logWarning("Bot profiles are not watched for changes", Cause.pretty(cause)),
      ),
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
      return { bot, soul: current.souls.get(id) ?? "" };
    });

    const write: BotStore["Service"]["write"] = Effect.fn("BotStore.write")(
      function* (profile, soul) {
        const dir = path.join(directory, profile.id);
        yield* fileSystem
          .makeDirectory(dir, { recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              botError("Could not create the bot folder.", { botId: profile.id, cause }),
            ),
          );
        yield* writeFileAtomic(
          profilePath(profile.id),
          `${JSON.stringify(profile, null, 2)}\n`,
        ).pipe(
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
        yield* reload;
        const written = yield* find(profile.id);
        return written ?? { ...profile, soulBytes: 0, threadTag: botThreadTag(profile.id) };
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
      remove,
      allocateId,
      soul,
    });
  }),
);
