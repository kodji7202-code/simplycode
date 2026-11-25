// A run is one run of the built-in `simplycode.pipeline` workflow; the service
// owns validation, the delete-refusals and starting it.
import {
  type BotId,
  BotError,
  type Pipeline,
  type PipelineDeleteInput,
  type PipelineDeleteResult,
  type PipelineListInput,
  type PipelineListResult,
  type PipelineMutationResult,
  type PipelineRunInput,
  type PipelineRunResult,
  type PipelineStage,
  type PipelineUpsertInput,
  PIPELINE_DEFAULT_LIMITS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import { PIPELINE_WORKFLOW_NAME } from "../workflows/pipelineDefinition.ts";
import * as Workflows from "../workflows/Workflows.ts";
import { BotStore } from "./BotStore.ts";
import { PipelineStore } from "./PipelineStore.ts";
import { TeamStore } from "./TeamStore.ts";

const pipelineError = (message: string) => new BotError({ message });

export class PipelineService extends Context.Service<
  PipelineService,
  {
    readonly list: (input: PipelineListInput) => Effect.Effect<PipelineListResult>;
    readonly subscribeList: (
      input: PipelineListInput,
    ) => Stream.Stream<PipelineListResult, BotError>;
    readonly upsert: (
      input: PipelineUpsertInput,
    ) => Effect.Effect<PipelineMutationResult, BotError>;
    readonly delete: (input: PipelineDeleteInput) => Effect.Effect<PipelineDeleteResult, BotError>;
    readonly run: (input: PipelineRunInput) => Effect.Effect<PipelineRunResult, BotError>;
  }
>()("simplycode/bots/PipelineService") {}

export const layer = Layer.effect(
  PipelineService,
  Effect.gen(function* () {
    const store = yield* PipelineStore;
    const teamStore = yield* TeamStore;
    const botStore = yield* BotStore;
    const workflows = yield* Workflows.Workflows;
    const settings = yield* ServerSettings.ServerSettingsService;

    /** What is wrong with `stages` on `team`'s members, or nothing. */
    const stageProblem = (
      stages: ReadonlyArray<PipelineStage>,
      memberBotIds: ReadonlyArray<BotId>,
    ): string | undefined => {
      const seen = new Set<string>();
      for (const stage of stages) {
        if (seen.has(stage.id)) return `Two stages are named "${stage.id}".`;
        seen.add(stage.id);
        if (!memberBotIds.includes(stage.botId)) {
          return `Stage "${stage.name}" runs on bot "${stage.botId}", which is not a member of the team.`;
        }
      }
      for (let index = 0; index < stages.length; index++) {
        const stage = stages[index]!;
        if (stage.onFail === undefined) {
          if (stage.kind === "review") {
            return `Stage "${stage.name}" is a review stage: it needs an "if it fails" stage to go back to.`;
          }
          continue;
        }
        if (stage.kind !== "review") {
          return `Stage "${stage.name}" is a work stage: only review stages take an "if it fails" stage.`;
        }
        const target = stages.findIndex((candidate) => candidate.id === stage.onFail);
        if (target === -1) {
          return `Stage "${stage.name}" goes back to "${stage.onFail}", which is not a stage of this pipeline.`;
        }
        if (target >= index) {
          return `Stage "${stage.name}" can only go back to an earlier stage.`;
        }
        if (stages[target]!.kind !== "work") {
          return `Stage "${stage.name}" can only go back to a work stage.`;
        }
      }
      return undefined;
    };

    const upsert: PipelineService["Service"]["upsert"] = Effect.fn("PipelineService.upsert")(
      function* (input) {
        const team = yield* teamStore.find(input.teamId);
        if (team === undefined) {
          return yield* pipelineError(`Team "${input.teamId}" was not found.`);
        }
        const problem = stageProblem(input.stages, team.memberBotIds);
        if (problem !== undefined) return yield* pipelineError(problem);
        const existing = input.id === undefined ? undefined : yield* store.find(input.id);
        if (input.id !== undefined && existing === undefined) {
          return yield* pipelineError("Pipeline not found.");
        }
        const id =
          input.id ??
          (yield* store
            .allocateId(input.name)
            .pipe(Effect.mapError(() => pipelineError("Could not allocate a pipeline id."))));
        const now = DateTime.formatIso(yield* DateTime.now);
        const pipeline: Pipeline = {
          id,
          teamId: input.teamId,
          name: input.name,
          stages: input.stages,
          limits: input.limits ?? existing?.limits ?? PIPELINE_DEFAULT_LIMITS,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          ...(input.description === undefined ? {} : { description: input.description }),
        };
        yield* store.write(pipeline);
        return { pipeline };
      },
    );

    const deletePipeline: PipelineService["Service"]["delete"] = Effect.fn(
      "PipelineService.delete",
    )(function* (input) {
      const pipeline = yield* store.find(input.id);
      if (pipeline === undefined) return yield* pipelineError("Pipeline not found.");
      yield* store.remove(input.id);
      return { id: input.id };
    });

    const run: PipelineService["Service"]["run"] = Effect.fn("PipelineService.run")(
      function* (input) {
        const current = yield* settings.getSettings.pipe(
          Effect.mapError(() => pipelineError("Could not read the server settings.")),
        );
        if (!current.workflowsEnabled) {
          return yield* pipelineError(Workflows.OFF);
        }
        const pipeline = yield* store.find(input.pipelineId);
        if (pipeline === undefined) return yield* pipelineError("Pipeline not found.");
        const team = yield* teamStore.find(pipeline.teamId);
        if (team === undefined) {
          return yield* pipelineError(`The pipeline's team "${pipeline.teamId}" was not found.`);
        }
        for (const stage of pipeline.stages) {
          const bot = yield* botStore.find(stage.botId);
          if (bot === undefined) {
            return yield* pipelineError(
              `Stage "${stage.name}" runs on bot "${stage.botId}", which was not found.`,
            );
          }
          if (!bot.enabled) {
            return yield* pipelineError(
              `Stage "${stage.name}" runs on bot "${bot.name}", which is disabled.`,
            );
          }
        }
        const projectId =
          input.projectId ??
          (yield* Effect.forEach(
            [team.leadBotId, pipeline.stages[0]!.botId].filter(
              (id): id is BotId => id !== undefined,
            ),
            (id) => botStore.find(id),
          ).pipe(Effect.map((bots) => bots.find((bot) => bot !== undefined)?.projectId)));
        if (projectId === undefined) {
          return yield* pipelineError("No project: the team has no bot to take one from.");
        }
        const key = `pipeline:${pipeline.id}:${
          input.commandId ?? DateTime.toEpochMillis(yield* DateTime.now)
        }`;
        const started = yield* workflows
          .start(
            PIPELINE_WORKFLOW_NAME,
            { pipelineId: pipeline.id, task: input.task, projectId },
            { idempotencyKey: key },
          )
          .pipe(Effect.mapError((error) => pipelineError(error.message)));
        return { runId: started.runId };
      },
    );

    return PipelineService.of({
      list: Effect.fn("PipelineService.list")(() => store.list()),
      subscribeList: () => store.subscribeList(),
      upsert,
      delete: deletePipeline,
      run,
    });
  }),
);
