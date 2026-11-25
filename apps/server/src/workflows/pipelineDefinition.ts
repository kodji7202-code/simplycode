// The built-in workflow that runs a bot pipeline: each stage is an `agent`
// step as its bot, review stages return a pass/fail verdict with findings, and
// a fail goes back to an earlier work stage. Round caps ask a person first.
// The body is journaled: a change here is a NEW VERSION kept alongside this one.
import {
  BotId,
  BotProfile,
  BotSkill,
  botRuntimeMode,
  botThreadTag,
  Pipeline,
  type PipelineStage,
  ProjectId,
  RuntimeMode,
  Team,
} from "@t3tools/contracts";
import { botPrompt } from "@t3tools/shared/botPrompt";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { botInstructions, type BotInstructionsTeam } from "../bots/botInstructions.ts";
import { runtimeModeRank } from "../mcp/delegatedTaskModes.ts";
import type { BotStore } from "../bots/BotStore.ts";
import type { PipelineStore } from "../bots/PipelineStore.ts";
import type { TeamStore } from "../bots/TeamStore.ts";
import { step, stop, title, workflow, type WorkflowDefinition } from "./workflow.ts";
import { agent, ask, type AgentThread } from "./workflowAgent.ts";

export const PIPELINE_WORKFLOW_NAME = "simplycode.pipeline";

export const PipelinePayload = Schema.Struct({
  pipelineId: Pipeline.fields.id,
  task: Schema.String,
  projectId: ProjectId,
  /** Stage threads launch with no more access than this; unset means each bot's own mode. */
  runtimeCeiling: Schema.optional(RuntimeMode),
});

const StageBotSnapshot = Schema.Struct({
  bot: BotProfile,
  soul: Schema.String,
  memory: Schema.String,
  skills: Schema.Array(BotSkill),
  skillsDir: Schema.String,
});

const TeamMemberSnapshot = Schema.Struct({
  id: BotId,
  name: Schema.String,
  role: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
});

const PipelineSnapshot = Schema.Struct({
  pipeline: Pipeline,
  team: Team,
  /** Every team member, for the lead's team section and run checks. */
  members: Schema.Array(TeamMemberSnapshot),
  /** Each stage bot's profile and instructions inputs, keyed by bot id. */
  bots: Schema.Record(Schema.String, StageBotSnapshot),
});

const PipelineResult = Schema.Struct({
  status: Schema.Literal("passed"),
  rounds: Schema.Int,
  summary: Schema.String,
});

const WorkOutput = Schema.Struct({ summary: Schema.String });
const ReviewOutput = Schema.Struct({
  verdict: Schema.Literals(["pass", "fail"]),
  findings: Schema.Array(Schema.String),
});

const ONE_MORE = "One more round";
const STOP = "Stop";

// Two failed reviews that found the same things, however ordered or punctuated.
const findingsKey = (findings: ReadonlyArray<string>) =>
  findings
    .map((finding) => finding.trim().toLowerCase())
    .sort()
    .join("\n");

export interface PipelineDefinitionDeps {
  readonly bots: BotStore["Service"];
  readonly teams: TeamStore["Service"];
  readonly pipelines: PipelineStore["Service"];
}

/**
 * The `simplycode.pipeline` workflow over live stores. Its first step snapshots
 * the pipeline, team and stage bots, so a run is replay-stable however the
 * files are edited while it runs.
 */
export const makePipelineDefinition = (deps: PipelineDefinitionDeps): WorkflowDefinition =>
  workflow(
    PIPELINE_WORKFLOW_NAME,
    { version: 1, payload: PipelinePayload, returns: PipelineResult },
    (payload) =>
      Effect.gen(function* () {
        const snapshot = yield* step(
          "snapshot",
          { returns: PipelineSnapshot },
          Effect.gen(function* () {
            const pipeline = yield* deps.pipelines.find(payload.pipelineId);
            if (pipeline === undefined) {
              return yield* Effect.die(new Error("The pipeline was not found."));
            }
            const team = yield* deps.teams.find(pipeline.teamId);
            if (team === undefined) {
              return yield* Effect.die(new Error(`The pipeline's team was not found.`));
            }
            const members: Array<typeof TeamMemberSnapshot.Type> = [];
            for (const memberId of team.memberBotIds) {
              const member = yield* deps.bots.find(memberId);
              if (member === undefined) continue;
              members.push({
                id: member.id,
                name: member.name,
                enabled: member.enabled,
                ...(member.role === undefined ? {} : { role: member.role }),
                ...(member.description === undefined ? {} : { description: member.description }),
              });
            }
            const bots: Record<string, typeof StageBotSnapshot.Type> = {};
            for (const stage of pipeline.stages) {
              if (bots[stage.botId] !== undefined) continue;
              const member = members.find((entry) => entry.id === stage.botId);
              if (member === undefined) {
                return yield* Effect.die(new Error(`Stage "${stage.name}"'s bot was not found.`));
              }
              const entry = yield* Effect.orDie(deps.bots.get(stage.botId));
              const {
                soulBytes: _soulBytes,
                memoryBytes: _memoryBytes,
                skills,
                threadTag: _threadTag,
                ...profile
              } = entry.bot;
              bots[stage.botId] = {
                bot: profile,
                soul: entry.soul,
                memory: entry.memory,
                skills,
                skillsDir: entry.skillsDir,
              };
            }
            return { pipeline, team, members, bots };
          }),
        );
        const { pipeline, team } = snapshot;
        yield* title(`${pipeline.name}: ${payload.task.slice(0, 60)}`);

        const instructionsFor = (snap: typeof StageBotSnapshot.Type): string => {
          const teamsLed: Array<BotInstructionsTeam> =
            team.leadBotId === snap.bot.id
              ? [
                  {
                    name: team.name,
                    members: snapshot.members
                      .filter((member) => member.enabled)
                      .map((member) => ({
                        id: member.id,
                        name: member.name,
                        ...(member.role === undefined ? {} : { role: member.role }),
                        ...(member.description === undefined
                          ? {}
                          : { description: member.description }),
                      })),
                  },
                ]
              : [];
          return botInstructions({
            soul: snap.soul,
            memory: snap.memory,
            skills: snap.skills,
            skillsDir: snap.skillsDir,
            teams: teamsLed,
          });
        };

        const stageBrief = (
          stage: PipelineStage,
          round: number,
          findings: ReadonlyArray<string>,
        ): string => {
          const lines = [
            `Pipeline "${pipeline.name}", stage "${stage.name}" (round ${round} of ${pipeline.limits.maxRounds}).`,
            `Task: ${payload.task}`,
            `Your part: ${stage.instructions}`,
          ];
          const earlier = pipeline.stages.filter(
            (candidate) => summaries.get(candidate.id) !== undefined,
          );
          if (earlier.length > 0) {
            lines.push(
              "Work from earlier stages:",
              ...earlier.map((candidate) => `- ${candidate.name}: ${summaries.get(candidate.id)}`),
            );
          }
          if (findings.length > 0) {
            lines.push("Reviewer findings to fix:", ...findings.map((finding) => `- ${finding}`));
          }
          lines.push(
            stage.kind === "review"
              ? `Check the work against the task. Submit verdict "pass" only if it is done and correct; otherwise "fail" with each concrete problem as one finding.`
              : "When you are done, submit your result.",
          );
          return lines.join("\n");
        };

        /** The newest summary each work stage produced. */
        const summaries = new Map<string, string>();
        /** Each stage's own thread, continued across rounds. */
        const threads = new Map<string, AgentThread>();
        let findings: ReadonlyArray<string> = [];
        let previousFail:
          | { readonly stageId: PipelineStage["id"]; readonly key: string }
          | undefined;
        let lastSummary = "";
        let round = 1;
        let index = 0;

        while (index < pipeline.stages.length) {
          const stage = pipeline.stages[index]!;
          const snap = snapshot.bots[stage.botId];
          if (snap === undefined) {
            return yield* Effect.die(
              new Error(`Stage "${stage.name}" has no snapshot of bot "${stage.botId}".`),
            );
          }
          const name = `${stage.id}@${round}`;
          const prior = threads.get(stage.id);
          const briefOnly = stageBrief(stage, round, stage.kind === "work" ? findings : []);
          const base = {
            // A continued thread already carries the bot's standing instructions.
            brief:
              prior === undefined
                ? botPrompt(snap.bot, instructionsFor(snap), briefOnly)
                : briefOnly,
            timeout: `${pipeline.limits.stageTimeoutMinutes} minutes` as const,
            ...(prior === undefined
              ? {
                  model: {
                    instanceId: snap.bot.modelSelection.instanceId,
                    model: snap.bot.modelSelection.model,
                    ...(snap.bot.modelSelection.options === undefined
                      ? {}
                      : { options: snap.bot.modelSelection.options }),
                  },
                  project: payload.projectId,
                  title: `${snap.bot.name}: ${stage.name}`,
                  runtimeMode:
                    payload.runtimeCeiling !== undefined &&
                    runtimeModeRank(payload.runtimeCeiling) <
                      runtimeModeRank(botRuntimeMode(snap.bot.approvalMode))
                      ? payload.runtimeCeiling
                      : botRuntimeMode(snap.bot.approvalMode),
                  interactionMode: snap.bot.interactionMode,
                  workspaceConfined: snap.bot.stayInProject,
                  tags: [botThreadTag(snap.bot.id)],
                }
              : { thread: prior }),
          };

          if (stage.kind === "work") {
            const result = yield* agent(name, { ...base, returns: WorkOutput });
            threads.set(stage.id, result.thread);
            summaries.set(stage.id, result.value.summary);
            lastSummary = result.value.summary;
            findings = [];
            index += 1;
            continue;
          }

          const verdict = yield* agent(name, { ...base, returns: ReviewOutput });
          threads.set(stage.id, verdict.thread);
          if (verdict.value.verdict === "pass") {
            index += 1;
            continue;
          }

          // A failed review sends the run back to the stage `onFail` names.
          round += 1;
          const key = findingsKey(verdict.value.findings);
          if (round > pipeline.limits.maxRounds) {
            const answer = yield* ask(`limit-${round}`, {
              title: `${pipeline.name}: review still failing after ${pipeline.limits.maxRounds} rounds. Last findings: ${verdict.value.findings.join("; ")}`,
              choices: [ONE_MORE, STOP],
              data: { findings: [...verdict.value.findings] },
            });
            if (Option.isNone(answer) || answer.value.choice === STOP) {
              return yield* stop(`stopped by you after ${round - 1} rounds`);
            }
          } else if (previousFail?.stageId === stage.id && previousFail.key === key) {
            const answer = yield* ask(`repeat-${round}`, {
              title: `${pipeline.name}: the reviewer repeated the same findings.`,
              choices: [ONE_MORE, STOP],
              data: { findings: [...verdict.value.findings] },
            });
            if (Option.isNone(answer) || answer.value.choice === STOP) {
              return yield* stop(`stopped by you after ${round - 1} rounds`);
            }
          }
          previousFail = { stageId: stage.id, key };
          findings = verdict.value.findings;
          index = pipeline.stages.findIndex((candidate) => candidate.id === stage.onFail);
          if (index < 0) {
            return yield* Effect.die(
              new Error(`Stage "${stage.name}"'s onFail stage was not found.`),
            );
          }
        }
        return { status: "passed" as const, rounds: round, summary: lastSummary };
      }),
  );
