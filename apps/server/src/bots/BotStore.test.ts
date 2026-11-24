import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BotId, BotProfile } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as BotStore from "./BotStore.ts";

const decodeProfile = Schema.decodeUnknownSync(BotProfile);

const profile = (id: string, name = "Night Watch"): BotProfile =>
  decodeProfile({
    id,
    name,
    enabled: true,
    projectId: "project-1",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    approvalMode: "auto-safe",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

const withStore = <A, E>(
  body: Effect.Effect<A, E, BotStore.BotStore | FileSystem.FileSystem | Path.Path | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-bots-" });
    return yield* body.pipe(
      Effect.provide(
        BotStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const seedFolder = (dir: string, botJson: string, soul?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, "bot.json"), botJson);
    if (soul !== undefined) yield* fs.writeFileString(path.join(dir, "SOUL.md"), soul);
  });

it.effect("writes, lists and reads back a bot with its soul", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      yield* store.write(profile("night-watch"), "Stand guard.");
      const listed = yield* store.list();
      expect(listed.bots).toHaveLength(1);
      const bot = listed.bots[0]!;
      expect(bot.id).toBe("night-watch");
      expect(bot.threadTag).toBe("bot:night-watch");
      expect(bot.soulBytes).toBe(Buffer.byteLength("Stand guard.", "utf8"));
      expect("soul" in bot).toBe(false);
      const got = yield* store.get(BotId.make("night-watch"));
      expect(got.soul).toBe("Stand guard.");
      expect(got.bot.name).toBe("Night Watch");
    }),
  ),
);

it.effect("reports invalid bot.json folders as load errors and keeps the rest", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-bots-" });
    const path = yield* Path.Path;
    const botsDir = path.join(baseDir, "bots");
    yield* seedFolder(path.join(botsDir, "good-bot"), JSON.stringify(profile("good-bot")));
    yield* seedFolder(path.join(botsDir, "bad-bot"), "{ not json");
    yield* seedFolder(path.join(botsDir, "mismatch"), JSON.stringify(profile("other-id")));

    const listed = yield* Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      return yield* store.list();
    }).pipe(
      Effect.provide(
        BotStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
    expect(listed.bots.map((bot) => bot.id)).toEqual(["good-bot"]);
    expect(listed.loadErrors.map((error) => error.folder).sort()).toEqual(["bad-bot", "mismatch"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports a SOUL.md over the byte limit as a load error", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-bots-" });
    const path = yield* Path.Path;
    yield* seedFolder(
      path.join(baseDir, "bots", "heavy-bot"),
      JSON.stringify(profile("heavy-bot")),
      "x".repeat(25_000),
    );

    const listed = yield* Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      return yield* store.list();
    }).pipe(
      Effect.provide(
        BotStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
    expect(listed.bots).toHaveLength(0);
    expect(listed.loadErrors[0]?.folder).toBe("heavy-bot");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("allocates -2 and -3 ids on collision and removes bots", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      const first = yield* store.allocateId("My Bot");
      expect(first).toBe("my-bot");
      yield* store.write(profile(first, "My Bot"));
      const second = yield* store.allocateId("my bot!");
      expect(second).toBe("my-bot-2");
      yield* store.write(profile(second));
      const third = yield* store.allocateId("MY   BOT");
      expect(third).toBe("my-bot-3");

      yield* store.remove(first);
      const listed = yield* store.list();
      expect(listed.bots.map((bot) => bot.id)).toEqual(["my-bot-2"]);
      const gone = yield* store.get(first).pipe(Effect.flip);
      expect(gone.message).toBe("Bot not found.");
    }),
  ),
);

it.effect("keeps the last good list when the bots folder cannot be read", () =>
  Effect.gen(function* () {
    const realFs = yield* FileSystem.FileSystem;
    const baseDir = yield* realFs.makeTempDirectoryScoped({ prefix: "simplycode-bots-" });
    const failReads = yield* Ref.make(false);
    const proxied = new Proxy(realFs, {
      get: (target, property, receiver) =>
        property === "readDirectory"
          ? (path: string) =>
              Effect.flatMap(Ref.get(failReads), (fail) =>
                fail ? Effect.die(new Error("unreadable")) : target.readDirectory(path),
              )
          : Reflect.get(target, property, receiver),
    });
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(FileSystem.FileSystem, proxied),
      ServerConfig.layerTest(process.cwd(), baseDir),
    );

    yield* Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      yield* store.write(profile("kept-bot"));

      yield* Ref.set(failReads, true);
      // The write lands on disk, but the reload cannot read the folder: the
      // in-memory list keeps its last good contents rather than going empty.
      yield* store.write(profile("unseen-bot"));
      expect((yield* store.list()).bots.map((bot) => bot.id)).toEqual(["kept-bot"]);

      yield* Ref.set(failReads, false);
      yield* store.write(profile("seen-bot"));
      expect((yield* store.list()).bots.map((bot) => bot.id).sort()).toEqual([
        "kept-bot",
        "seen-bot",
        "unseen-bot",
      ]);
    }).pipe(Effect.provide(BotStore.layer.pipe(Layer.provideMerge(dependencies))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("reloads when the bots folder changes on disk", () =>
  Effect.gen(function* () {
    const realFs = yield* FileSystem.FileSystem;
    const baseDir = yield* realFs.makeTempDirectoryScoped({ prefix: "simplycode-bots-" });
    yield* Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;

      const subscribed = yield* Deferred.make<void>();
      const next = yield* store.subscribeList().pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      yield* store.watchReady;
      yield* seedFolder(
        path.join(config.botsDir, "edited-bot"),
        JSON.stringify(profile("edited-bot")),
      );
      const emissions = yield* Effect.timeoutOption(Fiber.join(next), Duration.seconds(15));
      expect(Option.isSome(emissions)).toBe(true);
      const last = Option.isSome(emissions) ? emissions.value.at(-1) : undefined;
      expect(last?.bots.map((bot) => bot.id)).toEqual(["edited-bot"]);
    }).pipe(
      Effect.provide(
        BotStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
