import {
  BOT_AVATAR_COLORS,
  botAvatarOrDefault,
  type Bot,
  type BotApprovalMode,
  type BotAvatar,
  type BotUpsertInput,
  type ModelSelection,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type ProjectId,
  type ProviderInteractionMode,
  type ScheduledTask,
} from "@t3tools/contracts";
import { msg } from "gt-react";

export const BOT_APPROVAL_MODES = [
  "ask",
  "auto-safe",
  "full",
] as const satisfies ReadonlyArray<BotApprovalMode>;

export const APPROVAL_MODE_TITLES = {
  ask: msg("Ask"),
  "auto-safe": msg("Auto-safe"),
  full: msg("Full"),
} as const;

/** What each approval mode becomes at launch, named like the permission modes doc. */
export const APPROVAL_MODE_RUNTIME_LABELS = {
  ask: msg("Supervised"),
  "auto-safe": msg("Auto"),
  full: msg("Full access"),
} as const;

export const WORKSPACE_MODES = ["root", "worktree"] as const;
export type BotWorkspaceMode = (typeof WORKSPACE_MODES)[number];

export const WORKSPACE_MODE_LABELS = {
  root: msg("Project folder"),
  worktree: msg("New worktree"),
} as const;

export const BOT_AVATAR_SHAPE_LABELS = {
  rectangle: msg("Rectangle"),
  square: msg("Square"),
  circle: msg("Circle"),
  hexagon: msg("Hexagon"),
} as const;

/** New bots get a deterministic head until the user picks one. */
const NEW_BOT_AVATAR: BotAvatar = { shape: "rectangle", color: BOT_AVATAR_COLORS[0] };

export interface BotDraft {
  readonly editingId: Bot["id"] | null;
  readonly name: string;
  readonly avatar: BotAvatar;
  readonly role: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly pinned: boolean;
  readonly projectId: string;
  readonly workspaceMode: BotWorkspaceMode;
  readonly modelSelection: ModelSelection | null;
  readonly approvalMode: BotApprovalMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly soul: string;
  readonly maxStepsPerRun: string;
  readonly maxCostUsd: string;
}

export const EMPTY_BOT_DRAFT: BotDraft = {
  editingId: null,
  name: "",
  avatar: NEW_BOT_AVATAR,
  role: "",
  description: "",
  enabled: true,
  pinned: false,
  projectId: "",
  workspaceMode: "root",
  modelSelection: null,
  approvalMode: "ask",
  interactionMode: "default",
  soul: "",
  maxStepsPerRun: "",
  maxCostUsd: "",
};

export function botToDraft(bot: Bot, soul: string): BotDraft {
  return {
    editingId: bot.id,
    name: bot.name,
    avatar: botAvatarOrDefault(bot),
    role: bot.role ?? "",
    description: bot.description ?? "",
    enabled: bot.enabled,
    pinned: bot.pinned,
    projectId: bot.projectId,
    workspaceMode: bot.workspaceStrategy.type === "worktree" ? "worktree" : "root",
    modelSelection: bot.modelSelection,
    approvalMode: bot.approvalMode,
    interactionMode: bot.interactionMode,
    soul,
    maxStepsPerRun: bot.limits.maxStepsPerRun?.toString() ?? "",
    maxCostUsd: bot.limits.maxCostUsd?.toString() ?? "",
  };
}

export function soulByteLength(soul: string): number {
  return new TextEncoder().encode(soul).length;
}

export function botAutomationCount(tasks: ReadonlyArray<ScheduledTask>, botId: Bot["id"]): number {
  let count = 0;
  for (const task of tasks) if (task.botId === botId) count += 1;
  return count;
}

/** A stored worktree strategy loses its baseRef; relaunching resolves the default branch again. */
function draftWorkspaceStrategy(
  draft: BotDraft,
  worktreeBaseRef: string,
): OrchestrationV2ThreadLaunchWorkspaceStrategy {
  return draft.workspaceMode === "worktree"
    ? { type: "worktree", baseRef: worktreeBaseRef, startFromOrigin: true }
    : { type: "root" };
}

export function draftToBotUpsertInput(
  draft: BotDraft,
  worktreeBaseRef: string,
): BotUpsertInput | null {
  const name = draft.name.trim();
  const modelSelection = draft.modelSelection;
  if (!name || modelSelection === null) return null;
  const steps = Number.parseInt(draft.maxStepsPerRun, 10);
  const cost = Number.parseFloat(draft.maxCostUsd);
  return {
    ...(draft.editingId === null ? {} : { id: draft.editingId }),
    name,
    // Optional fields have no absent-means-clear on the wire, so empties clear them.
    avatar: draft.avatar,
    role: draft.role.trim(),
    description: draft.description.trim(),
    enabled: draft.enabled,
    pinned: draft.pinned,
    projectId: draft.projectId as ProjectId,
    workspaceStrategy: draftWorkspaceStrategy(draft, worktreeBaseRef),
    modelSelection,
    approvalMode: draft.approvalMode,
    interactionMode: draft.interactionMode,
    limits: {
      ...(Number.isSafeInteger(steps) && steps >= 1 ? { maxStepsPerRun: steps } : {}),
      ...(Number.isFinite(cost) && cost > 0 ? { maxCostUsd: cost } : {}),
    },
    soul: draft.soul,
  };
}
