import {
  PIPELINE_DEFAULT_LIMITS,
  PIPELINE_INSTRUCTIONS_MAX_CHARS,
  PIPELINE_MAX_ROUNDS,
  PIPELINE_MAX_STAGE_TIMEOUT_MINUTES,
  PIPELINE_MAX_STAGES,
  PIPELINE_MIN_STAGE_TIMEOUT_MINUTES,
  type BotId,
  type Pipeline,
  type PipelineId,
  type PipelineStage,
  type PipelineStageId,
  type PipelineStageKind,
  type PipelineUpsertInput,
  type Team,
  type TeamId,
  type TeamUpsertInput,
  type WorkflowRun,
} from "@t3tools/contracts";

export const PIPELINE_BOUNDS = {
  stages: PIPELINE_MAX_STAGES,
  instructionsChars: PIPELINE_INSTRUCTIONS_MAX_CHARS,
  maxRounds: { min: 1, max: PIPELINE_MAX_ROUNDS },
  stageTimeoutMinutes: {
    min: PIPELINE_MIN_STAGE_TIMEOUT_MINUTES,
    max: PIPELINE_MAX_STAGE_TIMEOUT_MINUTES,
  },
} as const;

export interface TeamDraft {
  readonly editingId: TeamId | null;
  readonly name: string;
  readonly description: string;
  /** Empty when the team has no lead. */
  readonly leadBotId: string;
  readonly memberBotIds: ReadonlyArray<string>;
}

export const emptyTeamDraft = (): TeamDraft => ({
  editingId: null,
  name: "",
  description: "",
  leadBotId: "",
  memberBotIds: [],
});

export const teamToDraft = (team: Team): TeamDraft => ({
  editingId: team.id,
  name: team.name,
  description: team.description ?? "",
  leadBotId: team.leadBotId ?? "",
  memberBotIds: [...team.memberBotIds],
});

/** Null when the draft cannot even be sent; rule violations are the server's to report. */
export function draftToTeamUpsertInput(draft: TeamDraft): TeamUpsertInput | null {
  const name = draft.name.trim();
  if (name === "") return null;
  const description = draft.description.trim();
  return {
    ...(draft.editingId === null ? {} : { id: draft.editingId }),
    name,
    ...(description === "" ? {} : { description }),
    ...(draft.leadBotId === "" ? {} : { leadBotId: draft.leadBotId as BotId }),
    memberBotIds: draft.memberBotIds as BotId[],
  };
}

export interface StageDraft {
  /** The stage's slug in the pipeline, kept stable across renames and reorders. */
  readonly id: string;
  readonly name: string;
  readonly botId: string;
  readonly kind: PipelineStageKind;
  readonly instructions: string;
  /** The stage a failed review goes back to; empty for a work stage. */
  readonly onFail: string;
}

export interface PipelineDraft {
  readonly editingId: PipelineId | null;
  readonly teamId: TeamId;
  readonly name: string;
  readonly description: string;
  readonly stages: ReadonlyArray<StageDraft>;
  readonly maxRounds: string;
  readonly stageTimeoutMinutes: string;
}

/** A stage id that satisfies the stage-slug pattern and is not in `taken`. */
export function slugifyStageId(seed: string, taken: ReadonlySet<string>): string {
  const base =
    seed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "stage";
  let candidate = base;
  for (let suffix = 2; taken.has(candidate); suffix += 1) {
    candidate = `${base.slice(0, 44)}-${suffix}`;
  }
  return candidate;
}

const stageToDraft = (stage: PipelineStage): StageDraft => ({
  id: stage.id,
  name: stage.name,
  botId: stage.botId,
  kind: stage.kind,
  instructions: stage.instructions,
  onFail: stage.onFail ?? "",
});

export const newStageDraft = (taken: ReadonlySet<string>): StageDraft => ({
  id: slugifyStageId("stage", taken),
  name: "",
  botId: "",
  kind: "work",
  instructions: "",
  onFail: "",
});

export const newPipelineDraft = (teamId: TeamId): PipelineDraft => ({
  editingId: null,
  teamId,
  name: "",
  description: "",
  stages: [newStageDraft(new Set())],
  maxRounds: String(PIPELINE_DEFAULT_LIMITS.maxRounds),
  stageTimeoutMinutes: String(PIPELINE_DEFAULT_LIMITS.stageTimeoutMinutes),
});

export const pipelineToDraft = (pipeline: Pipeline): PipelineDraft => ({
  editingId: pipeline.id,
  teamId: pipeline.teamId,
  name: pipeline.name,
  description: pipeline.description ?? "",
  stages: pipeline.stages.map(stageToDraft),
  maxRounds: String(pipeline.limits.maxRounds),
  stageTimeoutMinutes: String(pipeline.limits.stageTimeoutMinutes),
});

/**
 * Null when a field is empty: the stage bots' names and instructions are required and the
 * semantic rules (membership, onFail targets) are reported by the server on save.
 */
export function draftToPipelineUpsertInput(draft: PipelineDraft): PipelineUpsertInput | null {
  const name = draft.name.trim();
  if (name === "" || draft.stages.length === 0 || draft.stages.length > PIPELINE_MAX_STAGES) {
    return null;
  }
  if (
    draft.stages.some(
      (stage) => stage.name.trim() === "" || stage.botId === "" || stage.instructions.trim() === "",
    )
  ) {
    return null;
  }
  const maxRounds = Number.parseInt(draft.maxRounds, 10);
  const stageTimeoutMinutes = Number.parseInt(draft.stageTimeoutMinutes, 10);
  const description = draft.description.trim();
  return {
    ...(draft.editingId === null ? {} : { id: draft.editingId }),
    teamId: draft.teamId,
    name,
    ...(description === "" ? {} : { description }),
    stages: draft.stages.map((stage) => ({
      id: stage.id as PipelineStageId,
      name: stage.name.trim(),
      botId: stage.botId as BotId,
      kind: stage.kind,
      instructions: stage.instructions,
      ...(stage.kind === "review" && stage.onFail !== ""
        ? { onFail: stage.onFail as PipelineStageId }
        : {}),
    })),
    ...(Number.isSafeInteger(maxRounds) && Number.isSafeInteger(stageTimeoutMinutes)
      ? { limits: { maxRounds, stageTimeoutMinutes } }
      : {}),
  };
}

/** The idempotency-key prefix every run of this pipeline was started under. */
const pipelineRunKeyPrefix = (pipelineId: string): string => `pipeline:${pipelineId}:`;

/** Runs of one pipeline, newest first (the run list already comes newest first). */
export function pipelineRuns(
  runs: ReadonlyArray<WorkflowRun>,
  pipelineId: string,
): ReadonlyArray<WorkflowRun> {
  const prefix = pipelineRunKeyPrefix(pipelineId);
  return runs.filter((run) => run.key !== null && run.key.startsWith(prefix));
}

/** "Dev → Review" for a pipeline row. */
export const stageChainLabel = (pipeline: Pick<Pipeline, "stages">): string =>
  pipeline.stages.map((stage) => stage.name).join(" → ");
