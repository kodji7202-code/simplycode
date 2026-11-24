import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "./orchestrationV2.ts";
import { ProviderInteractionMode } from "./providerPolicy.ts";

/**
 * A bot's id is also the name of its folder under `bots/` in the server home,
 * so it stays path-safe on every filesystem the server runs on.
 */
export const BotId = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/)).pipe(
  Schema.brand("BotId"),
);
export type BotId = typeof BotId.Type;

const BOT_SOUL_MAX_BYTES = 24_000;

export const BotApprovalMode = Schema.Literals(["ask", "auto-safe", "full"]);
export type BotApprovalMode = typeof BotApprovalMode.Type;

export const BotLimits = Schema.Struct({
  maxStepsPerRun: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  maxCostUsd: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
});
export type BotLimits = typeof BotLimits.Type;

export const BotProfile = Schema.Struct({
  id: BotId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^[^\r\n]+$/)),
  avatar: Schema.optional(Schema.String.check(Schema.isMaxLength(8))),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  enabled: Schema.Boolean,
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

/** The wire item carries the soul's size only; the text itself is fetched with `bots.get`. */
export const Bot = Schema.Struct({
  ...BotProfile.fields,
  soulBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
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
});
export type BotGetResult = typeof BotGetResult.Type;

export const BotUpsertInput = Schema.Struct({
  id: Schema.optional(BotId),
  name: BotProfile.fields.name,
  avatar: BotProfile.fields.avatar,
  description: BotProfile.fields.description,
  enabled: Schema.Boolean,
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

export const BotRunNowInput = Schema.Struct({
  id: BotId,
  prompt: TrimmedNonEmptyString,
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
