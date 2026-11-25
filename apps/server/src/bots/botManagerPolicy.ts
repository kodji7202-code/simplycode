// What a bot running with "Can create and edit other bots" may do through the
// bot-management MCP tools, and nothing more. Pure checks: the handlers resolve
// the caller and the providers, the policy says no with the message to return.
import {
  type Bot,
  type BotApprovalMode,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";

import { mapModelSelection } from "./modelMapping.ts";

export const approvalRank = (mode: BotApprovalMode): number =>
  mode === "ask" ? 0 : mode === "auto-safe" ? 1 : 2;

export const NOT_A_MANAGER_MESSAGE =
  'This bot isn\'t allowed to manage bots. Turn on "Can create and edit other bots" in its profile.';

/** The caller bot must exist, be enabled and have canManageBots. */
export function managerDenial(caller: Bot | undefined): string | undefined {
  return caller !== undefined && caller.enabled && caller.canManageBots
    ? undefined
    : NOT_A_MANAGER_MESSAGE;
}

export function approvalDenial(
  requested: BotApprovalMode,
  own: BotApprovalMode,
): string | undefined {
  return approvalRank(requested) > approvalRank(own)
    ? `Approval mode "${requested}" is above your own ("${own}").`
    : undefined;
}

/** Create: approval defaults to the caller's and may not rise above it. */
export function createDenial(
  caller: Bot,
  input: { readonly approvalMode?: BotApprovalMode | undefined },
): string | undefined {
  const requested = input.approvalMode ?? caller.approvalMode;
  return approvalDenial(requested, caller.approvalMode);
}

const aboveOwnApprovalMessage = (target: BotApprovalMode, own: BotApprovalMode): string =>
  `You can't edit a bot whose approval mode ("${target}") is above your own ("${own}").`;

/** Update: not self, not another manager, not above the caller's own approval. */
export function updateDenial(
  caller: Bot,
  target: Bot,
  input: { readonly approvalMode?: BotApprovalMode | undefined },
): string | undefined {
  if (caller.id === target.id) return "You can't edit yourself.";
  if (target.canManageBots) return "You can't edit another bot that manages bots.";
  if (approvalRank(target.approvalMode) > approvalRank(caller.approvalMode))
    return aboveOwnApprovalMessage(target.approvalMode, caller.approvalMode);
  return input.approvalMode === undefined
    ? undefined
    : approvalDenial(input.approvalMode, caller.approvalMode);
}

/** install_bot_skill allows the caller itself, or a target update_bot could edit. */
export function installSkillDenial(caller: Bot, target: Bot): string | undefined {
  if (caller.id === target.id) return undefined;
  if (target.canManageBots) return "You can't edit another bot that manages bots.";
  return approvalRank(target.approvalMode) > approvalRank(caller.approvalMode)
    ? aboveOwnApprovalMessage(target.approvalMode, caller.approvalMode)
    : undefined;
}

/**
 * No member's approval may be above the caller's, whether the bots are being
 * added to a team or are already on one the caller wants to change.
 */
export function teamDenial(caller: Bot, memberBots: ReadonlyArray<Bot>): string | undefined {
  const above = memberBots.find(
    (member) => approvalRank(member.approvalMode) > approvalRank(caller.approvalMode),
  );
  return above === undefined
    ? undefined
    : `You can't add "${above.name}" to a team: its approval mode ("${above.approvalMode}") is above your own ("${caller.approvalMode}").`;
}

/** The same rule for a pipeline's stage bots. */
export function pipelineDenial(
  caller: Bot,
  stageBots: ReadonlyArray<{ readonly stage: string; readonly bot: Bot }>,
): string | undefined {
  const above = stageBots.find(
    (entry) => approvalRank(entry.bot.approvalMode) > approvalRank(caller.approvalMode),
  );
  return above === undefined
    ? undefined
    : `Stage "${above.stage}" can't use "${above.bot.name}": its approval mode ("${above.bot.approvalMode}") is above your own ("${caller.approvalMode}").`;
}

/**
 * A `model` pick names an instance and a slug; it must exist on this server,
 * with the import's matching rule (instance id or driver, case-insensitive).
 * Returns the resolved selection or the message to refuse with.
 */
export function resolveModelPick(
  pick: { readonly providerInstanceId: string; readonly model: string },
  providers: ReadonlyArray<ServerProvider>,
): { readonly modelSelection: ModelSelection } | { readonly denial: string } {
  const modelSelection = mapModelSelection(
    { sourceProvider: pick.providerInstanceId, sourceModelSlug: pick.model },
    providers,
  );
  if (modelSelection !== undefined) return { modelSelection };
  const ids = providers.map((provider) => provider.instanceId).join(", ");
  return {
    denial: `Model "${pick.model}" is not available on provider "${pick.providerInstanceId}". Available provider instances: ${ids === "" ? "none" : ids}.`,
  };
}
