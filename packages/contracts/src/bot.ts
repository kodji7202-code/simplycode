import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CommandId,
  ForwardCompatibleArray,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "./orchestrationV2.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { BOT_THREAD_TAG_PREFIX } from "./threadTags.ts";

/**
 * A bot's id is also the name of its folder under `bots/` in the server home,
 * so it stays path-safe on every filesystem the server runs on.
 */
export const BotId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/)).pipe(
  Schema.brand("BotId"),
);
export type BotId = typeof BotId.Type;

/**
 * A skill's folder slug under `bots/<id>/skills/`: lowercase, 64 chars like
 * Claude's limit, path-safe on every filesystem the server runs on.
 */
export const BotSkillName = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)).pipe(
  Schema.brand("BotSkillName"),
);
export type BotSkillName = typeof BotSkillName.Type;

/**
 * Turns any source folder or package name into a valid skill slug; undefined
 * when nothing usable remains.
 */
export function normalizeBotSkillName(value: string): BotSkillName | undefined {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug.length === 0 ? undefined : BotSkillName.make(slug);
}

export const BOT_SOUL_MAX_BYTES = 24_000;
export const BOT_MEMORY_MAX_BYTES = 16_000;

export const BotApprovalMode = Schema.Literals(["ask", "auto-safe", "full"]);
export type BotApprovalMode = typeof BotApprovalMode.Type;

export const BOT_AVATAR_SHAPES = ["rectangle", "square", "circle", "hexagon"] as const;
export const BotAvatarShape = Schema.Literals(BOT_AVATAR_SHAPES);
export type BotAvatarShape = typeof BotAvatarShape.Type;

export const BOT_AVATAR_COLORS = [
  "#00d47e",
  "#3b82f6",
  "#f59e0b",
  "#a855f7",
  "#ec4899",
  "#06b6d4",
  "#ef4444",
  "#84cc16",
] as const;

export const BotAvatar = Schema.Struct({
  shape: BotAvatarShape,
  color: Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
});
export type BotAvatar = typeof BotAvatar.Type;

/** Bots without a chosen avatar still get a stable head, derived from their id. */
export function botAvatarOrDefault(bot: {
  readonly id: string;
  readonly avatar?: BotAvatar | undefined;
}): BotAvatar {
  if (bot.avatar !== undefined) return bot.avatar;
  let hash = 0;
  for (let i = 0; i < bot.id.length; i++) {
    hash = (hash * 31 + bot.id.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash);
  return {
    shape: BOT_AVATAR_SHAPES[index % BOT_AVATAR_SHAPES.length]!,
    color: BOT_AVATAR_COLORS[(index >>> 4) % BOT_AVATAR_COLORS.length]!,
  };
}

/** The runtime mode a bot's threads launch with, derived from its approval mode. */
export function botRuntimeMode(mode: BotApprovalMode): RuntimeMode {
  switch (mode) {
    case "ask":
      return "approval-required";
    case "auto-safe":
      return "auto";
    case "full":
      return "full-access";
  }
}

export const BotLimits = Schema.Struct({
  maxStepsPerRun: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  maxCostUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
});
export type BotLimits = typeof BotLimits.Type;

export function botThreadTag(id: BotId): string {
  return `${BOT_THREAD_TAG_PREFIX}${id}`;
}

export const BotProfile = Schema.Struct({
  id: BotId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^[^\r\n]+$/)),
  avatar: Schema.optional(BotAvatar),
  role: Schema.optional(
    Schema.String.check(Schema.isMaxLength(60), Schema.isPattern(/^[^\r\n]*$/)),
  ),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  enabled: Schema.Boolean,
  pinned: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  projectId: ProjectId,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  approvalMode: BotApprovalMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("default" as const)),
  ),
  limits: BotLimits.pipe(Schema.withDecodingDefaultKey(Effect.succeed({}))),
  /** Whether this bot may create and edit other bots through the MCP tools. */
  canManageBots: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotProfile = typeof BotProfile.Type;

/**
 * An installed skill: a `skills/<name>/` folder with a SKILL.md. The name is
 * the folder slug, so it follows the BotSkillName pattern.
 */
export const BotSkill = Schema.Struct({
  name: BotSkillName,
  description: Schema.optional(TrimmedNonEmptyString),
});
export type BotSkill = typeof BotSkill.Type;

/** The wire item carries the soul's and memory's sizes only; the texts are fetched with `bots.get`. */
export const Bot = Schema.Struct({
  ...BotProfile.fields,
  soulBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  memoryBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
  ),
  skills: ForwardCompatibleArray(BotSkill).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([] as ReadonlyArray<BotSkill>)),
  ),
  threadTag: TrimmedNonEmptyString,
});
export type Bot = typeof Bot.Type;

export const BotLoadError = Schema.Struct({
  folder: Schema.String,
  message: Schema.String,
});
export type BotLoadError = typeof BotLoadError.Type;

export const BotListInput = Schema.Struct({});
export type BotListInput = typeof BotListInput.Type;

export const BotListResult = Schema.Struct({
  bots: ForwardCompatibleArray(Bot),
  loadErrors: Schema.Array(BotLoadError),
});
export type BotListResult = typeof BotListResult.Type;

export const BotGetInput = Schema.Struct({
  id: BotId,
});
export type BotGetInput = typeof BotGetInput.Type;

export const BotGetResult = Schema.Struct({
  bot: Bot,
  soul: Schema.String,
  memory: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
});
export type BotGetResult = typeof BotGetResult.Type;

export const BotUpsertInput = Schema.Struct({
  id: Schema.optional(BotId),
  name: BotProfile.fields.name,
  avatar: BotProfile.fields.avatar,
  role: BotProfile.fields.role,
  description: BotProfile.fields.description,
  enabled: Schema.Boolean,
  /** Omitted on update: keep the stored value. Omitted on create: false. */
  pinned: Schema.optional(Schema.Boolean),
  projectId: ProjectId,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  modelSelection: ModelSelection,
  approvalMode: BotApprovalMode,
  /** Omitted on update: keep the stored value. Omitted on create: "default". */
  interactionMode: Schema.optional(ProviderInteractionMode),
  /** Omitted on update: keep the stored value. Omitted on create: no limits. */
  limits: Schema.optional(BotLimits),
  /** Omitted on update: keep the stored value. Omitted on create: false. */
  canManageBots: Schema.optional(Schema.Boolean),
  /** Omitted: keep the stored SOUL.md (or no soul for a new bot). */
  soul: Schema.optional(Schema.String.check(Schema.isMaxLength(BOT_SOUL_MAX_BYTES))),
  /** Omitted: keep the stored MEMORY.md. An empty string deletes it. */
  memory: Schema.optional(Schema.String.check(Schema.isMaxLength(BOT_MEMORY_MAX_BYTES))),
});
export type BotUpsertInput = typeof BotUpsertInput.Type;

export const BotMutationResult = Schema.Struct({
  bot: Bot,
});
export type BotMutationResult = typeof BotMutationResult.Type;

export const BotSetEnabledInput = Schema.Struct({
  id: BotId,
  enabled: Schema.Boolean,
});
export type BotSetEnabledInput = typeof BotSetEnabledInput.Type;

export const BotDeleteInput = Schema.Struct({
  id: BotId,
});
export type BotDeleteInput = typeof BotDeleteInput.Type;

export const BotDeleteResult = Schema.Struct({
  id: BotId,
});
export type BotDeleteResult = typeof BotDeleteResult.Type;

export const BotInstallSkillInput = Schema.Struct({
  id: BotId,
  /** A SKILL.md file, or a folder containing one; copied into the bot's skills folder. */
  sourcePath: TrimmedNonEmptyString,
});
export type BotInstallSkillInput = typeof BotInstallSkillInput.Type;

export const BotRemoveSkillInput = Schema.Struct({
  id: BotId,
  name: BotSkillName,
});
export type BotRemoveSkillInput = typeof BotRemoveSkillInput.Type;

export const BotRunNowInput = Schema.Struct({
  id: BotId,
  prompt: TrimmedNonEmptyString,
  /** Replays with the same commandId return the same thread instead of launching again. */
  commandId: Schema.optional(CommandId),
});
export type BotRunNowInput = typeof BotRunNowInput.Type;

export const BotRunNowResult = Schema.Struct({
  threadId: ThreadId,
});
export type BotRunNowResult = typeof BotRunNowResult.Type;

/**
 * A team's id is the name of its file under `teams/` in the server home, so it
 * shares the bot-id alphabet and stays path-safe everywhere.
 */
export const TeamId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/)).pipe(
  Schema.brand("TeamId"),
);
export type TeamId = typeof TeamId.Type;

export const PipelineId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/)).pipe(
  Schema.brand("PipelineId"),
);
export type PipelineId = typeof PipelineId.Type;

/** A stage's slug, unique inside its pipeline. */
export const PipelineStageId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/),
).pipe(Schema.brand("PipelineStageId"));
export type PipelineStageId = typeof PipelineStageId.Type;

export const Team = Schema.Struct({
  id: TeamId,
  name: BotProfile.fields.name,
  description: BotProfile.fields.description,
  leadBotId: Schema.optional(BotId),
  memberBotIds: Schema.Array(BotId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Team = typeof Team.Type;

export const TeamListInput = Schema.Struct({});
export type TeamListInput = typeof TeamListInput.Type;

export const TeamListResult = Schema.Struct({
  teams: ForwardCompatibleArray(Team),
  loadErrors: Schema.Array(BotLoadError),
});
export type TeamListResult = typeof TeamListResult.Type;

export const TeamUpsertInput = Schema.Struct({
  id: Schema.optional(TeamId),
  name: Team.fields.name,
  description: Team.fields.description,
  leadBotId: Schema.optional(BotId),
  memberBotIds: Schema.Array(BotId),
});
export type TeamUpsertInput = typeof TeamUpsertInput.Type;

export const TeamMutationResult = Schema.Struct({
  team: Team,
});
export type TeamMutationResult = typeof TeamMutationResult.Type;

export const TeamDeleteInput = Schema.Struct({
  id: TeamId,
});
export type TeamDeleteInput = typeof TeamDeleteInput.Type;

export const TeamDeleteResult = Schema.Struct({
  id: TeamId,
});
export type TeamDeleteResult = typeof TeamDeleteResult.Type;

export const PIPELINE_MAX_STAGES = 12;
export const PIPELINE_INSTRUCTIONS_MAX_CHARS = 4_000;
export const PIPELINE_MAX_ROUNDS = 10;
export const PIPELINE_MAX_STAGE_TIMEOUT_MINUTES = 480;
export const PIPELINE_MIN_STAGE_TIMEOUT_MINUTES = 5;
const PIPELINE_DEFAULT_MAX_ROUNDS = 3;
const PIPELINE_DEFAULT_STAGE_TIMEOUT_MINUTES = 60;

export const PipelineStageKind = Schema.Literals(["work", "review"]);
export type PipelineStageKind = typeof PipelineStageKind.Type;

export const PipelineStage = Schema.Struct({
  id: PipelineStageId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  botId: BotId,
  kind: PipelineStageKind,
  instructions: Schema.String.check(Schema.isMaxLength(PIPELINE_INSTRUCTIONS_MAX_CHARS)),
  /** For a review stage, the earlier work stage a failed review goes back to. */
  onFail: Schema.optional(PipelineStageId),
});
export type PipelineStage = typeof PipelineStage.Type;

export const PipelineLimits = Schema.Struct({
  maxRounds: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(PIPELINE_MAX_ROUNDS),
  ),
  stageTimeoutMinutes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(PIPELINE_MIN_STAGE_TIMEOUT_MINUTES),
    Schema.isLessThanOrEqualTo(PIPELINE_MAX_STAGE_TIMEOUT_MINUTES),
  ),
});
export type PipelineLimits = typeof PipelineLimits.Type;

export const PIPELINE_DEFAULT_LIMITS: PipelineLimits = {
  maxRounds: PIPELINE_DEFAULT_MAX_ROUNDS,
  stageTimeoutMinutes: PIPELINE_DEFAULT_STAGE_TIMEOUT_MINUTES,
};

export const Pipeline = Schema.Struct({
  id: PipelineId,
  teamId: TeamId,
  name: Team.fields.name,
  description: Team.fields.description,
  stages: Schema.Array(PipelineStage).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PIPELINE_MAX_STAGES),
  ),
  limits: PipelineLimits,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Pipeline = typeof Pipeline.Type;

export const PipelineListInput = Schema.Struct({});
export type PipelineListInput = typeof PipelineListInput.Type;

export const PipelineListResult = Schema.Struct({
  pipelines: ForwardCompatibleArray(Pipeline),
  loadErrors: Schema.Array(BotLoadError),
});
export type PipelineListResult = typeof PipelineListResult.Type;

export const PipelineUpsertInput = Schema.Struct({
  id: Schema.optional(PipelineId),
  teamId: TeamId,
  name: Pipeline.fields.name,
  description: Pipeline.fields.description,
  stages: Pipeline.fields.stages,
  /** Omitted on update: keep the stored value. Omitted on create: the defaults. */
  limits: Schema.optional(PipelineLimits),
});
export type PipelineUpsertInput = typeof PipelineUpsertInput.Type;

export const PipelineMutationResult = Schema.Struct({
  pipeline: Pipeline,
});
export type PipelineMutationResult = typeof PipelineMutationResult.Type;

export const PipelineDeleteInput = Schema.Struct({
  id: PipelineId,
});
export type PipelineDeleteInput = typeof PipelineDeleteInput.Type;

export const PipelineDeleteResult = Schema.Struct({
  id: PipelineId,
});
export type PipelineDeleteResult = typeof PipelineDeleteResult.Type;

export const PipelineRunInput = Schema.Struct({
  pipelineId: PipelineId,
  task: TrimmedNonEmptyString,
  /** The project the stages share; defaults to the lead's, then the first stage bot's. */
  projectId: Schema.optional(ProjectId),
  /** Replays with the same commandId return the same run instead of starting again. */
  commandId: Schema.optional(CommandId),
});
export type PipelineRunInput = typeof PipelineRunInput.Type;

export const PipelineRunResult = Schema.Struct({
  runId: Schema.String,
});
export type PipelineRunResult = typeof PipelineRunResult.Type;

/** Where a bot import reads candidates from. Package content is sent again on apply. */
export const BotImportSource = Schema.Union([
  Schema.Struct({ type: Schema.Literal("openbot") }),
  Schema.Struct({ type: Schema.Literal("openmausbot") }),
  Schema.Struct({ type: Schema.Literal("folder"), path: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("package"), content: Schema.String }),
]);
export type BotImportSource = typeof BotImportSource.Type;

export const BotImportAutomationPreview = Schema.Struct({
  name: TrimmedNonEmptyString,
  scheduleLabel: Schema.String,
  importable: Schema.Boolean,
});
export type BotImportAutomationPreview = typeof BotImportAutomationPreview.Type;

/** A bot the scan found, with everything the preview needs and nothing it doesn't. */
export const BotImportCandidate = Schema.Struct({
  /** Stable within one source; apply sends back the keys to import. */
  key: TrimmedNonEmptyString,
  name: BotProfile.fields.name,
  role: BotProfile.fields.role,
  description: BotProfile.fields.description,
  avatar: Schema.optional(BotAvatar),
  /** The source's own model label, for "not available here" preview lines. */
  sourceModel: Schema.optional(Schema.String),
  /** Set only when the source model maps to a provider instance and model on this server. */
  modelSelection: Schema.optional(ModelSelection),
  approvalMode: BotApprovalMode,
  soulBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  memoryBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
  ),
  skills: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([] as ReadonlyArray<string>)),
  ),
  automations: Schema.Array(BotImportAutomationPreview).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([] as ReadonlyArray<BotImportAutomationPreview>)),
  ),
  warnings: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([] as ReadonlyArray<string>)),
  ),
});
export type BotImportCandidate = typeof BotImportCandidate.Type;

export const BotImportScanInput = Schema.Struct({
  source: BotImportSource,
});
export type BotImportScanInput = typeof BotImportScanInput.Type;

export const BotImportScanResult = Schema.Struct({
  sourceLabel: TrimmedNonEmptyString,
  candidates: ForwardCompatibleArray(BotImportCandidate),
  /** Source-level problems, such as package bots rejected for unsafe paths. */
  warnings: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([] as ReadonlyArray<string>)),
  ),
});
export type BotImportScanResult = typeof BotImportScanResult.Type;

export const BotImportApplyInclude = Schema.Struct({
  memory: Schema.Boolean,
  skills: Schema.Boolean,
  automations: Schema.Boolean,
});
export type BotImportApplyInclude = typeof BotImportApplyInclude.Type;

export const BotImportApplyInput = Schema.Struct({
  source: BotImportSource,
  keys: Schema.Array(TrimmedNonEmptyString),
  projectId: ProjectId,
  /** Used for every candidate whose own model could not be mapped. */
  fallbackModelSelection: ModelSelection,
  include: BotImportApplyInclude,
});
export type BotImportApplyInput = typeof BotImportApplyInput.Type;

export const BotImportApplyResult = Schema.Struct({
  bots: ForwardCompatibleArray(Bot),
  warnings: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([] as ReadonlyArray<string>)),
  ),
});
export type BotImportApplyResult = typeof BotImportApplyResult.Type;

export const BotExportInput = Schema.Struct({
  ids: Schema.Array(BotId).check(Schema.isMinLength(1)),
  includeMemory: Schema.Boolean,
});
export type BotExportInput = typeof BotExportInput.Type;

export const BotExportResult = Schema.Struct({
  fileName: TrimmedNonEmptyString,
  content: Schema.String,
});
export type BotExportResult = typeof BotExportResult.Type;

export class BotError extends Schema.TaggedError<BotError>()("BotError", {
  message: Schema.String,
  botId: Schema.optional(BotId),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** An empty object: `Schema.Struct({})` advertises "any non-null" as MCP input JSON schema. */
export const BotsMcpListInput = Schema.Record(Schema.String, Schema.Never);
export type BotsMcpListInput = typeof BotsMcpListInput.Type;

export const BotsMcpListedBot = Schema.Struct({
  id: BotId,
  name: BotProfile.fields.name,
  role: BotProfile.fields.role,
  description: BotProfile.fields.description,
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  approvalMode: BotApprovalMode,
});
export type BotsMcpListedBot = typeof BotsMcpListedBot.Type;

export const BotsMcpListResult = Schema.Struct({
  selfBotId: Schema.NullOr(BotId),
  bots: Schema.Array(BotsMcpListedBot),
});
export type BotsMcpListResult = typeof BotsMcpListResult.Type;

export const BotsMcpUpdateMemoryInput = Schema.Struct({
  mode: Schema.Literals(["append", "replace"]),
  text: Schema.String,
});
export type BotsMcpUpdateMemoryInput = typeof BotsMcpUpdateMemoryInput.Type;

export const BotsMcpUpdateMemoryResult = Schema.Struct({
  botId: BotId,
  memoryBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type BotsMcpUpdateMemoryResult = typeof BotsMcpUpdateMemoryResult.Type;

/** The bot-management tools take `{ providerInstanceId, model }`, like the list_bots shape. */
const BotsMcpModelPick = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
});

export const BotsMcpGetBotInput = Schema.Struct({
  botId: BotId,
});
export type BotsMcpGetBotInput = typeof BotsMcpGetBotInput.Type;

export const BotsMcpGetBotResult = Schema.Struct({
  bot: Schema.Struct({
    ...BotsMcpListedBot.fields,
    avatar: Schema.optional(BotAvatar),
    interactionMode: ProviderInteractionMode,
    canManageBots: Schema.Boolean,
    skills: Schema.Array(BotSkill),
    soul: Schema.String,
    memoryBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
});
export type BotsMcpGetBotResult = typeof BotsMcpGetBotResult.Type;

export const BotsMcpCreateBotInput = Schema.Struct({
  name: BotProfile.fields.name,
  role: BotProfile.fields.role,
  description: BotProfile.fields.description,
  soul: Schema.String.check(Schema.isMaxLength(BOT_SOUL_MAX_BYTES)),
  model: Schema.optional(BotsMcpModelPick),
  approvalMode: Schema.optional(BotApprovalMode),
  avatar: Schema.optional(BotAvatar),
});
export type BotsMcpCreateBotInput = typeof BotsMcpCreateBotInput.Type;

export const BotsMcpCreateBotResult = Schema.Struct({
  botId: BotId,
});
export type BotsMcpCreateBotResult = typeof BotsMcpCreateBotResult.Type;

export const BotsMcpUpdateBotInput = Schema.Struct({
  botId: BotId,
  name: Schema.optional(BotProfile.fields.name),
  role: BotProfile.fields.role,
  description: BotProfile.fields.description,
  soul: Schema.optional(Schema.String.check(Schema.isMaxLength(BOT_SOUL_MAX_BYTES))),
  model: Schema.optional(BotsMcpModelPick),
  approvalMode: Schema.optional(BotApprovalMode),
});
export type BotsMcpUpdateBotInput = typeof BotsMcpUpdateBotInput.Type;

export const BotsMcpUpdateBotResult = Schema.Struct({
  botId: BotId,
});
export type BotsMcpUpdateBotResult = typeof BotsMcpUpdateBotResult.Type;

export const BotsMcpInstallBotSkillInput = Schema.Struct({
  botId: BotId,
  /** A SKILL.md file, or the folder that holds one, on this machine. */
  sourcePath: TrimmedNonEmptyString,
});
export type BotsMcpInstallBotSkillInput = typeof BotsMcpInstallBotSkillInput.Type;

export const BotsMcpInstallBotSkillResult = Schema.Struct({
  botId: BotId,
  skills: Schema.Array(BotSkillName),
});
export type BotsMcpInstallBotSkillResult = typeof BotsMcpInstallBotSkillResult.Type;
