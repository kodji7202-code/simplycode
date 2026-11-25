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
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotProfile = typeof BotProfile.Type;

/**
 * An installed skill: a `skills/<name>/` folder with a SKILL.md. The name is
 * the folder slug, so it follows the BotId pattern.
 */
export const BotSkill = Schema.Struct({
  name: BotId,
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
  name: BotId,
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
