import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BotId, BotError, BotProfile, BotSkillName } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
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

it.effect("loads a bot.json that still carries a legacy string avatar", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-bots-" });
    const path = yield* Path.Path;
    const botsDir = path.join(baseDir, "bots");
    yield* seedFolder(
      path.join(botsDir, "legacy-bot"),
      JSON.stringify({ ...profile("legacy-bot"), avatar: "🌙" }),
    );

    const listed = yield* Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      return yield* store.list();
    }).pipe(
      Effect.provide(
        BotStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
    expect(listed.loadErrors).toEqual([]);
    expect(listed.bots.map((bot) => bot.id)).toEqual(["legacy-bot"]);
    expect(listed.bots[0]?.avatar).toBeUndefined();
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

it.live("reloads when MEMORY.md inside a bot folder changes on disk", () =>
  Effect.gen(function* () {
    const realFs = yield* FileSystem.FileSystem;
    const baseDir = yield* realFs.makeTempDirectoryScoped({ prefix: "simplycode-bots-" });
    yield* Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const dir = path.join(config.botsDir, "watched-bot");
      yield* seedFolder(dir, JSON.stringify(profile("watched-bot")));

      const subscribed = yield* Deferred.make<void>();
      const next = yield* store.subscribeList().pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      yield* store.watchReady;
      yield* fs.writeFileString(path.join(dir, "MEMORY.md"), "The project codename is Aurora.");
      const emissions = yield* Effect.timeoutOption(Fiber.join(next), Duration.seconds(15));
      expect(Option.isSome(emissions)).toBe(true);
      const last = Option.isSome(emissions) ? emissions.value.at(-1) : undefined;
      const listedBot = last?.bots.find((bot) => bot.id === "watched-bot");
      expect(listedBot?.memoryBytes).toBe(
        Buffer.byteLength("The project codename is Aurora.", "utf8"),
      );
      const got = yield* store.get(BotId.make("watched-bot"));
      expect(got.memory).toBe("The project codename is Aurora.");
    }).pipe(
      Effect.provide(
        BotStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("writes, reloads and clears a bot's memory", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      const written = yield* store.write(profile("night-watch"), "", "The user prefers dark mode.");
      expect(written.memoryBytes).toBe(Buffer.byteLength("The user prefers dark mode.", "utf8"));
      const got = yield* store.get(BotId.make("night-watch"));
      expect(got.memory).toBe("The user prefers dark mode.");

      yield* store.write(profile("night-watch"), undefined, "");
      const cleared = yield* store.get(BotId.make("night-watch"));
      expect(cleared.memory).toBe("");
      expect(cleared.bot.memoryBytes).toBe(0);
    }),
  ),
);

it.effect("keeps an over-cap MEMORY.md loadable and truncated at the cap", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-bots-" });
    const path = yield* Path.Path;
    yield* Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      const config = yield* ServerConfig.ServerConfig;
      const dir = path.join(config.botsDir, "night-watch");
      yield* seedFolder(dir, JSON.stringify(profile("night-watch")));
      // The last character is a 2-byte é straddling the cap, so the cut must
      // back off to the code-point boundary rather than split it.
      const overCap = "x".repeat(15_999) + "é" + "y".repeat(10);
      yield* fs.writeFileString(path.join(dir, "MEMORY.md"), overCap);
      yield* store.write(profile("other-bot"));
      const listed = yield* store.list();
      expect(listed.loadErrors).toEqual([]);
      const listedBot = listed.bots.find((bot) => bot.id === "night-watch");
      expect(listedBot?.memoryBytes).toBe(Buffer.byteLength(overCap, "utf8"));

      const got = yield* store.get(BotId.make("night-watch"));
      const kept = got.memory.split("\n\n(Memory is over")[0] ?? "";
      expect(kept).toBe("x".repeat(15_999));
      expect(got.memory.endsWith("Condense it with update_bot_memory in replace mode.)")).toBe(
        true,
      );
      expect(got.memory).not.toContain("�");
    }).pipe(
      Effect.provide(
        BotStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const seedSkill = (root: string, name: string, contents: string, extra?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(root, name);
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, "SKILL.md"), contents);
    if (extra !== undefined) {
      yield* fs.makeDirectory(path.join(dir, "refs"), { recursive: true });
      yield* fs.writeFileString(path.join(dir, "refs", "guide.txt"), extra);
    }
    return dir;
  });

const expectBotError = <A>(effect: Effect.Effect<A, BotError>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    expect(Result.isFailure(result)).toBe(true);
    return Result.isFailure(result) ? result.failure : undefined;
  });

it.effect("installs a skill from a folder and from a SKILL.md path, then removes it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-bots-" });
    const path = yield* Path.Path;
    yield* Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      const config = yield* ServerConfig.ServerConfig;
      const sourceRoot = path.join(path.dirname(config.botsDir), "skills-src");
      yield* store.write(profile("night-watch"));

      const folder = yield* seedSkill(
        sourceRoot,
        "deploy",
        '---\ndescription: "Ships the release"\n---\n# Deploy\n',
        "check the changelog",
      );
      const installed = yield* store.installSkill(BotId.make("night-watch"), folder);
      expect(installed.skills).toEqual([{ name: "deploy", description: "Ships the release" }]);
      const copied = yield* fs.readFileString(
        path.join(config.botsDir, "night-watch", "skills", "deploy", "refs", "guide.txt"),
      );
      expect(copied).toBe("check the changelog");
      const got = yield* store.get(BotId.make("night-watch"));
      expect(got.skills[0]?.path.endsWith(path.join("deploy", "SKILL.md"))).toBe(true);

      const skillFile = yield* seedSkill(path.join(sourceRoot, "second"), "triage", "# Triage\n");
      const fromFile = yield* store.installSkill(
        BotId.make("night-watch"),
        path.join(skillFile, "SKILL.md"),
      );
      expect(fromFile.skills.map((skill) => skill.name).sort()).toEqual(["deploy", "triage"]);

      const removed = yield* store.removeSkill(
        BotId.make("night-watch"),
        BotSkillName.make("deploy"),
      );
      expect(removed.skills.map((skill) => skill.name)).toEqual(["triage"]);
      expect(yield* fs.exists(path.join(config.botsDir, "night-watch", "skills", "deploy"))).toBe(
        false,
      );
    }).pipe(
      Effect.provide(
        BotStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("normalizes source folder names into valid skill slugs", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-bots-" });
    const path = yield* Path.Path;
    yield* Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      const sourceRoot = path.join(
        path.dirname((yield* ServerConfig.ServerConfig).botsDir),
        "skills-src",
      );
      yield* store.write(profile("night-watch"));

      const longName = "a".repeat(56);
      const long = yield* seedSkill(sourceRoot, longName, "# Long\n");
      const installedLong = yield* store.installSkill(BotId.make("night-watch"), long);
      expect(installedLong.skills.map((skill) => skill.name)).toEqual([longName]);

      const odd = yield* seedSkill(sourceRoot, "My_Skill.v2", "# Odd\n");
      const installed = yield* store.installSkill(BotId.make("night-watch"), odd);
      expect(installed.skills.map((skill) => skill.name).sort()).toEqual([longName, "my-skill-v2"]);
    }).pipe(
      Effect.provide(
        BotStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a folder without SKILL.md and overwrites on reinstall", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-bots-" });
    const path = yield* Path.Path;
    yield* Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      const config = yield* ServerConfig.ServerConfig;
      const sourceRoot = path.join(path.dirname(config.botsDir), "skills-src");
      yield* store.write(profile("night-watch"));

      const empty = path.join(sourceRoot, "empty-skill");
      yield* fs.makeDirectory(empty, { recursive: true });
      const failure = yield* expectBotError(store.installSkill(BotId.make("night-watch"), empty));
      expect(failure?.message).toContain("SKILL.md");

      const wrongCase = path.join(sourceRoot, "case-skill");
      yield* fs.makeDirectory(wrongCase, { recursive: true });
      yield* fs.writeFileString(path.join(wrongCase, "skill.md"), "# Lower\n");
      const caseFailure = yield* expectBotError(
        store.installSkill(BotId.make("night-watch"), wrongCase),
      );
      expect(caseFailure?.message).toContain("SKILL.md");

      const folder = yield* seedSkill(sourceRoot, "deploy", "v1");
      yield* store.installSkill(BotId.make("night-watch"), folder);
      yield* fs.writeFileString(path.join(folder, "SKILL.md"), "v2");
      yield* store.installSkill(BotId.make("night-watch"), folder);
      const reread = yield* fs.readFileString(
        path.join(config.botsDir, "night-watch", "skills", "deploy", "SKILL.md"),
      );
      expect(reread).toBe("v2");
    }).pipe(
      Effect.provide(
        BotStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects a skill over 2 MB before writing anything", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-bots-" });
    const path = yield* Path.Path;
    yield* Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      const config = yield* ServerConfig.ServerConfig;
      const sourceRoot = path.join(path.dirname(config.botsDir), "skills-src");
      yield* store.write(profile("night-watch"));

      const folder = yield* seedSkill(sourceRoot, "huge-skill", "# Big\n");
      yield* fs.writeFileString(path.join(folder, "blob.bin"), "x".repeat(2 * 1024 * 1024 + 1));
      const failure = yield* expectBotError(store.installSkill(BotId.make("night-watch"), folder));
      expect(failure?.message).toContain("2 MB");
      expect(
        yield* fs.exists(path.join(config.botsDir, "night-watch", "skills", "huge-skill")),
      ).toBe(false);
    }).pipe(
      Effect.provide(
        BotStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(!symlinksSupported)("rejects a skill containing a symbolic link", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-bots-" });
    const path = yield* Path.Path;
    yield* Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      const config = yield* ServerConfig.ServerConfig;
      const sourceRoot = path.join(path.dirname(config.botsDir), "skills-src");
      yield* store.write(profile("night-watch"));

      const folder = yield* seedSkill(sourceRoot, "linked-skill", "# Links\n");
      yield* fs.writeFileString(path.join(sourceRoot, "outside.txt"), "secret");
      yield* fs.symlink(path.join(sourceRoot, "outside.txt"), path.join(folder, "outside.txt"));
      const failure = yield* expectBotError(store.installSkill(BotId.make("night-watch"), folder));
      expect(failure?.message).toContain("symbolic link");
      expect(
        yield* fs.exists(path.join(config.botsDir, "night-watch", "skills", "linked-skill")),
      ).toBe(false);
    }).pipe(
      Effect.provide(
        BotStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
