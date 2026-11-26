import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotId,
  BotProfile,
  CommandId,
  type PipelineStage,
  type PipelineUpsertInput,
  TeamId,
} from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Workflows from "../workflows/Workflows.ts";
import { PIPELINE_WORKFLOW_NAME } from "../workflows/pipelineDefinition.ts";
import * as BotStore from "./BotStore.ts";
import * as PipelineStore from "./PipelineStore.ts";
import * as TeamStore from "./TeamStore.ts";
import * as PipelineService from "./PipelineService.ts";

const decodeProfile = Schema.decodeUnknownSync(BotProfile);

const profile = (id: string, over: Record<string, unknown> = {}): BotProfile =>
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
    ...over,
  });

const work = (id: string, botId = "dev"): PipelineStage => ({
  id: id as PipelineStage["id"],
  name: id,
  botId: BotId.make(botId),
  kind: "work",
  instructions: "Do it.",
});

const review = (id: string, onFail = "dev", botId = "reviewer"): PipelineStage => ({
  ...work(id, botId),
  kind: "review",
  onFail: onFail as PipelineStage["id"],
});

const upsertInput = (over: Partial<PipelineUpsertInput> = {}): PipelineUpsertInput => ({
  teamId: TeamId.make("build"),
  name: "Ship",
  stages: [work("dev"), review("review")],
  ...over,
});

interface Starts {
  readonly calls: Array<{
    readonly workflow: string;
    readonly input: unknown;
    readonly key: string;
  }>;
  readonly failWith?: Workflows.WorkflowError;
}

const withService = <A, E>(
  input: { workflowsEnabled?: boolean; starts: Starts },
  body: Effect.Effect<
    A,
    E,
    | PipelineService.PipelineService
    | PipelineStore.PipelineStore
    | TeamStore.TeamStore
    | BotStore.BotStore
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-pipes-" });
    const configLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
      Layer.provideMerge(NodeServices.layer),
    );
    const storesLayer = Layer.mergeAll(TeamStore.layer, BotStore.layer, PipelineStore.layer).pipe(
      Layer.provideMerge(configLayer),
    );
    const workflowsMock = Layer.mock(Workflows.Workflows)({
      start: (workflow, startInput, options) =>
        input.starts.failWith !== undefined
          ? Effect.fail(input.starts.failWith)
          : Effect.sync(() => {
              input.starts.calls.push({
                workflow,
                input: startInput,
                key: options.idempotencyKey,
              });
              return { runId: "run-1" };
            }),
    });
    const settingsMock = Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        workflowsEnabled: input.workflowsEnabled ?? true,
      }),
    });
    const serviceLayer = PipelineService.layer.pipe(
      Layer.provide(Layer.mergeAll(storesLayer, workflowsMock, settingsMock)),
    );
    return yield* body.pipe(Effect.provide(Layer.mergeAll(serviceLayer, storesLayer)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** A team "build" whose members are dev, reviewer and planner. */
const seedTeam = Effect.gen(function* () {
  const botStore = yield* BotStore.BotStore;
  const teamStore = yield* TeamStore.TeamStore;
  yield* botStore.write(profile("dev", { projectId: "dev-project" }));
  yield* botStore.write(profile("reviewer", { projectId: "reviewer-project" }));
  yield* botStore.write(profile("planner", { projectId: "lead-project" }));
  yield* teamStore.write({
    id: TeamId.make("build"),
    name: "Build",
    leadBotId: BotId.make("planner"),
    memberBotIds: [BotId.make("dev"), BotId.make("reviewer"), BotId.make("planner")],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
});

it.effect("creates a pipeline with the default limits", () =>
  withService(
    { starts: { calls: [] } },
    Effect.gen(function* () {
      yield* seedTeam;
      const service = yield* PipelineService.PipelineService;
      const created = yield* service.upsert(upsertInput());
      expect(created.pipeline.id).toBe("ship");
      expect(created.pipeline.limits).toEqual({ maxRounds: 3, stageTimeoutMinutes: 60 });
    }),
  ),
);

it.effect("refuses a stage whose bot is not on the team, and duplicate stage ids", () =>
  withService(
    { starts: { calls: [] } },
    Effect.gen(function* () {
      yield* seedTeam;
      const service = yield* PipelineService.PipelineService;

      const outsider = yield* service
        .upsert(upsertInput({ stages: [work("dev", "ghost")] }))
        .pipe(Effect.flip);
      expect(outsider.message).toBe(
        'Stage "dev" runs on bot "ghost", which is not a member of the team.',
      );

      const duplicated = yield* service
        .upsert(upsertInput({ stages: [work("dev"), work("dev")] }))
        .pipe(Effect.flip);
      expect(duplicated.message).toBe('Two stages are named "dev".');

      const noTeam = yield* service
        .upsert(upsertInput({ teamId: TeamId.make("gone") }))
        .pipe(Effect.flip);
      expect(noTeam.message).toBe('Team "gone" was not found.');
    }),
  ),
);

it.effect("enforces the onFail rules for review and work stages", () =>
  withService(
    { starts: { calls: [] } },
    Effect.gen(function* () {
      yield* seedTeam;
      const service = yield* PipelineService.PipelineService;

      const reviewWithout = yield* service
        .upsert(upsertInput({ stages: [work("dev"), { ...review("review"), onFail: undefined }] }))
        .pipe(Effect.flip);
      expect(reviewWithout.message).toBe(
        'Stage "review" is a review stage: it needs an "if it fails" stage to go back to.',
      );

      const workWith = yield* service
        .upsert(
          upsertInput({ stages: [{ ...work("dev"), onFail: "dev" as never }, review("review")] }),
        )
        .pipe(Effect.flip);
      expect(workWith.message).toBe(
        'Stage "dev" is a work stage: only review stages take an "if it fails" stage.',
      );

      const unknownTarget = yield* service
        .upsert(upsertInput({ stages: [work("dev"), review("review", "nope")] }))
        .pipe(Effect.flip);
      expect(unknownTarget.message).toBe(
        'Stage "review" goes back to "nope", which is not a stage of this pipeline.',
      );

      const laterStage = yield* service
        .upsert(
          upsertInput({
            stages: [work("dev"), review("check", "fix"), work("fix"), review("review", "dev")],
          }),
        )
        .pipe(Effect.flip);
      expect(laterStage.message).toBe('Stage "check" can only go back to an earlier stage.');

      const toReview = yield* service
        .upsert(
          upsertInput({
            stages: [work("dev"), review("first", "dev"), review("second", "first")],
          }),
        )
        .pipe(Effect.flip);
      expect(toReview.message).toBe('Stage "second" can only go back to a work stage.');
    }),
  ),
);

it.effect("run refuses while workflows are off", () =>
  withService(
    { workflowsEnabled: false, starts: { calls: [] } },
    Effect.gen(function* () {
      const service = yield* PipelineService.PipelineService;
      const off = yield* service
        .run({ pipelineId: "ship" as never, task: "Do it." })
        .pipe(Effect.flip);
      expect(off.message).toBe(Workflows.OFF);
    }),
  ),
);

it.effect("run starts the built-in workflow with the lead's project and the run key", () => {
  const starts: Starts = { calls: [] };
  return withService(
    { starts },
    Effect.gen(function* () {
      yield* seedTeam;
      const service = yield* PipelineService.PipelineService;
      yield* service.upsert(upsertInput());

      const result = yield* service.run({
        pipelineId: "ship" as never,
        task: "Add a health endpoint.",
        commandId: CommandId.make("cmd-7"),
      });
      expect(result.runId).toBe("run-1");

      expect(starts.calls).toEqual([
        {
          workflow: PIPELINE_WORKFLOW_NAME,
          input: { pipelineId: "ship", task: "Add a health endpoint.", projectId: "lead-project" },
          key: "pipeline:ship:cmd-7",
        },
      ]);
    }),
  );
});

it.effect("run falls back to the first stage bot's project, then refuses without one", () => {
  const starts: Starts = { calls: [] };
  return withService(
    { starts },
    Effect.gen(function* () {
      const service = yield* PipelineService.PipelineService;
      const teamStore = yield* TeamStore.TeamStore;
      const botStore = yield* BotStore.BotStore;
      // No lead: the project comes from the first stage's bot.
      yield* botStore.write(profile("dev", { projectId: "dev-project" }));
      yield* teamStore.write({
        id: TeamId.make("build"),
        name: "Build",
        memberBotIds: [BotId.make("dev")],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      yield* service.upsert(upsertInput({ stages: [work("dev")] }));

      yield* service.run({ pipelineId: "ship" as never, task: "Do it." });
      expect(starts.calls[0]?.input).toMatchObject({ projectId: "dev-project" });
      // A commandId-free run still keys on the pipeline, suffixed by the clock.
      expect(starts.calls[0]?.key).toMatch(/^pipeline:ship:\d+$/);

      // And an explicit projectId wins over both defaults.
      yield* service.run({
        pipelineId: "ship" as never,
        task: "Do it.",
        projectId: "chosen" as never,
      });
      expect(starts.calls[1]?.input).toMatchObject({ projectId: "chosen" });
    }),
  );
});

it.effect("run refuses a pipeline whose team or stage bots are gone or disabled", () =>
  withService(
    { starts: { calls: [] } },
    Effect.gen(function* () {
      yield* seedTeam;
      const service = yield* PipelineService.PipelineService;
      const teamStore = yield* TeamStore.TeamStore;
      const botStore = yield* BotStore.BotStore;
      yield* service.upsert(upsertInput());

      const missing = yield* service
        .run({ pipelineId: "gone" as never, task: "Do it." })
        .pipe(Effect.flip);
      expect(missing.message).toBe("Pipeline not found.");

      // The team vanishes behind the pipeline's back.
      yield* teamStore.remove(TeamId.make("build"));
      const orphaned = yield* service
        .run({ pipelineId: "ship" as never, task: "Do it." })
        .pipe(Effect.flip);
      expect(orphaned.message).toBe('The pipeline\'s team "build" was not found.');

      yield* seedTeam;
      // A stage bot is disabled after the pipeline was saved.
      yield* botStore.write(profile("reviewer", { enabled: false }));
      const disabled = yield* service
        .run({ pipelineId: "ship" as never, task: "Do it." })
        .pipe(Effect.flip);
      expect(disabled.message).toBe('Stage "review" runs on bot "reviewer", which is disabled.');

      yield* botStore.remove(BotId.make("reviewer"));
      const gone = yield* service
        .run({ pipelineId: "ship" as never, task: "Do it." })
        .pipe(Effect.flip);
      expect(gone.message).toBe('Stage "review" runs on bot "reviewer", which was not found.');
    }),
  ),
);

it.effect("run maps a workflow start failure into a BotError", () =>
  withService(
    {
      starts: {
        calls: [],
        failWith: new Workflows.WorkflowInputError({ problem: "no such workflow" }),
      },
    },
    Effect.gen(function* () {
      yield* seedTeam;
      const service = yield* PipelineService.PipelineService;
      yield* service.upsert(upsertInput());
      const failed = yield* service
        .run({ pipelineId: "ship" as never, task: "Do it." })
        .pipe(Effect.flip);
      expect(failed.message).toBe("no such workflow");
    }),
  ),
);

it.effect("deletes a pipeline and refuses an unknown one", () =>
  withService(
    { starts: { calls: [] } },
    Effect.gen(function* () {
      yield* seedTeam;
      const service = yield* PipelineService.PipelineService;
      yield* service.upsert(upsertInput());
      yield* service.delete({ id: "ship" as never });
      const { pipelines } = yield* service.list({});
      expect(pipelines).toHaveLength(0);
      const gone = yield* service.delete({ id: "ship" as never }).pipe(Effect.flip);
      expect(gone.message).toBe("Pipeline not found.");
    }),
  ),
);
