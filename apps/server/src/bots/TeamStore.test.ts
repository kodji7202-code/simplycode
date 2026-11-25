import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Team, TeamId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as TeamStore from "./TeamStore.ts";

const decodeTeam = Schema.decodeUnknownSync(Team);

const team = (id: string, over: Record<string, unknown> = {}): Team =>
  decodeTeam({
    id,
    name: id,
    memberBotIds: ["dev"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  });

const withStore = <A, E>(
  body: Effect.Effect<
    A,
    E,
    | TeamStore.TeamStore
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-teams-" });
    return yield* body.pipe(
      Effect.provide(
        TeamStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("writes, lists, finds and removes a team", () =>
  withStore(
    Effect.gen(function* () {
      const store = yield* TeamStore.TeamStore;
      yield* store.write(team("build", { name: "Build" }));
      const found = yield* store.find(TeamId.make("build"));
      expect(found?.name).toBe("Build");
      const { teams, loadErrors } = yield* store.list();
      expect(teams.map((t) => t.id)).toEqual(["build"]);
      expect(loadErrors).toEqual([]);

      yield* store.remove(TeamId.make("build"));
      expect(yield* store.find(TeamId.make("build"))).toBeUndefined();

      const allocated = yield* store.allocateId("Build Two");
      expect(allocated).toBe("build-two");
    }),
  ),
);

it.effect("keeps the good teams and reports the file that fails to decode", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-teams-" });
    const path = yield* Path.Path;
    const teamsDir = path.join(baseDir, "teams");
    yield* fs.makeDirectory(teamsDir, { recursive: true });
    yield* fs.writeFileString(path.join(teamsDir, "build.json"), JSON.stringify(team("build")));
    yield* fs.writeFileString(path.join(teamsDir, "broken.json"), "not json {");

    yield* Effect.gen(function* () {
      const store = yield* TeamStore.TeamStore;
      const { teams, loadErrors } = yield* store.list();
      expect(teams.map((t) => t.id)).toEqual(["build"]);
      expect(loadErrors).toHaveLength(1);
      expect(loadErrors[0]?.folder ?? "").toContain("broken.json");
    }).pipe(
      Effect.provide(
        TeamStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("reloads when a team file lands on disk", () =>
  Effect.gen(function* () {
    const realFs = yield* FileSystem.FileSystem;
    const baseDir = yield* realFs.makeTempDirectoryScoped({ prefix: "simplycode-teams-" });
    yield* Effect.gen(function* () {
      const store = yield* TeamStore.TeamStore;
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const subscribed = yield* Deferred.make<void>();
      const next = yield* store.subscribeList().pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      yield* store.watchReady;
      yield* fs.makeDirectory(config.teamsDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(config.teamsDir, "edited.json"),
        JSON.stringify(team("edited", { name: "Edited" })),
      );
      const emissions = yield* Effect.timeoutOption(Fiber.join(next), Duration.seconds(15));
      expect(Option.isSome(emissions)).toBe(true);
      const last = Option.isSome(emissions) ? emissions.value.at(-1) : undefined;
      expect(last?.teams.map((t) => t.id)).toEqual(["edited"]);
    }).pipe(
      Effect.provide(
        TeamStore.layer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
