import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BotId, BotProfile, Pipeline, type TeamUpsertInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as BotStore from "./BotStore.ts";
import * as PipelineStore from "./PipelineStore.ts";
import * as TeamStore from "./TeamStore.ts";
import * as TeamService from "./TeamService.ts";

const decodeProfile = Schema.decodeUnknownSync(BotProfile);
const decodePipeline = Schema.decodeUnknownSync(Pipeline);

const profile = (id: string): BotProfile =>
  decodeProfile({
    id,
    name: id,
    enabled: true,
    projectId: "project-1",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    approvalMode: "auto-safe",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

const upsertInput = (over: Partial<TeamUpsertInput> = {}): TeamUpsertInput => ({
  name: "Build",
  memberBotIds: [BotId.make("dev"), BotId.make("reviewer")],
  ...over,
});

const pipeline = (teamId: string): Pipeline =>
  decodePipeline({
    id: "ship",
    teamId,
    name: "Ship",
    stages: [
      { id: "dev", name: "Dev", botId: "dev", kind: "work", instructions: "Build it." },
      {
        id: "review",
        name: "Review",
        botId: "reviewer",
        kind: "review",
        instructions: "Check it.",
        onFail: "dev",
      },
    ],
    limits: { maxRounds: 3, stageTimeoutMinutes: 60 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

const withService = <A, E>(
  body: Effect.Effect<
    A,
    E,
    | TeamService.TeamService
    | TeamStore.TeamStore
    | BotStore.BotStore
    | PipelineStore.PipelineStore
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-teams-" });
    const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
      Layer.provideMerge(NodeServices.layer),
    );
    const storesLayer = Layer.mergeAll(TeamStore.layer, BotStore.layer, PipelineStore.layer).pipe(
      Layer.provideMerge(configLayer),
    );
    const serviceLayer = TeamService.layer.pipe(Layer.provide(storesLayer));
    return yield* body.pipe(Effect.provide(Layer.mergeAll(serviceLayer, storesLayer)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const seedMembers = Effect.gen(function* () {
  const botStore = yield* BotStore.BotStore;
  yield* botStore.write(profile("dev"));
  yield* botStore.write(profile("reviewer"));
  yield* botStore.write(profile("planner"));
});

it.effect("creates a team with a slug id and updates it in place", () =>
  withService(
    Effect.gen(function* () {
      yield* seedMembers;
      const service = yield* TeamService.TeamService;
      const created = yield* service.upsert(
        upsertInput({ leadBotId: BotId.make("planner"), description: "The builders." }),
      );
      expect(created.team.id).toBe("build");
      expect(created.team.leadBotId).toBe("planner");

      const updated = yield* service.upsert(
        upsertInput({ id: created.team.id, name: "Build Two", memberBotIds: [BotId.make("dev")] }),
      );
      expect(updated.team.id).toBe("build");
      expect(updated.team.memberBotIds).toEqual(["dev"]);
      expect(updated.team.createdAt).toBe(created.team.createdAt);
      // Fields left out of the input are dropped, not kept.
      expect(updated.team.leadBotId).toBeUndefined();
    }),
  ),
);

it.effect("refuses members that are missing or duplicated, and a missing lead", () =>
  withService(
    Effect.gen(function* () {
      yield* seedMembers;
      const service = yield* TeamService.TeamService;

      const missing = yield* service
        .upsert(upsertInput({ memberBotIds: [BotId.make("dev"), BotId.make("ghost")] }))
        .pipe(Effect.flip);
      expect(missing.message).toBe('Member bot "ghost" was not found.');

      const twice = yield* service
        .upsert(upsertInput({ memberBotIds: [BotId.make("dev"), BotId.make("dev")] }))
        .pipe(Effect.flip);
      expect(twice.message).toBe('Bot "dev" is a member twice.');

      const lead = yield* service
        .upsert(upsertInput({ leadBotId: BotId.make("ghost") }))
        .pipe(Effect.flip);
      expect(lead.message).toBe('Lead bot "ghost" was not found.');

      const unknown = yield* service
        .upsert(upsertInput({ id: "no-such-team" as never }))
        .pipe(Effect.flip);
      expect(unknown.message).toBe("Team not found.");
    }),
  ),
);

it.effect("refuses to delete a team a pipeline still uses", () =>
  withService(
    Effect.gen(function* () {
      yield* seedMembers;
      const service = yield* TeamService.TeamService;
      const pipelineStore = yield* PipelineStore.PipelineStore;

      const created = yield* service.upsert(upsertInput());
      yield* pipelineStore.write(pipeline(created.team.id));

      const refused = yield* service.delete({ id: created.team.id }).pipe(Effect.flip);
      expect(refused.message).toBe('A pipeline still uses this team: "Ship". Delete it first.');

      yield* pipelineStore.remove("ship" as never);
      yield* service.delete({ id: created.team.id });
      const { teams } = yield* service.list({});
      expect(teams).toHaveLength(0);

      const gone = yield* service.delete({ id: created.team.id }).pipe(Effect.flip);
      expect(gone.message).toBe("Team not found.");
    }),
  ),
);
