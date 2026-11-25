import {
  BOT_AVATAR_COLORS,
  botAvatarOrDefault,
  type Bot,
  type BotApprovalMode,
  type BotAvatar,
  type BotImportCandidate,
  type BotUpsertInput,
  type ModelSelection,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ProviderInteractionMode,
  type ScheduledTask,
} from "@t3tools/contracts";
import { DateTime } from "effect";
import { msg } from "gt-react";

import { m, type MessageResolver } from "../../i18n/messages";

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

export const BOT_AVATAR_COLOR_LABELS = {
  "#00d47e": msg("Emerald"),
  "#3b82f6": msg("Blue"),
  "#f59e0b": msg("Amber"),
  "#a855f7": msg("Purple"),
  "#ec4899": msg("Pink"),
  "#06b6d4": msg("Cyan"),
  "#ef4444": msg("Red"),
  "#84cc16": msg("Lime"),
} as const;

/** Where a discovered provider skill came from. */
export const BOT_SKILL_SOURCE_LABELS = {
  app: msg("App"),
  repo: msg("Repository"),
  project: msg("Project"),
  personal: msg("Personal"),
  system: msg("System"),
  other: msg("Other"),
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
  readonly memory: string;
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
  memory: "",
  maxStepsPerRun: "",
  maxCostUsd: "",
};

export function botToDraft(bot: Bot, soul: string, memory: string): BotDraft {
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
    memory,
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
    memory: draft.memory,
  };
}

type BotShell = Pick<
  OrchestrationV2ThreadShell,
  | "tags"
  | "title"
  | "status"
  | "activityRunStatus"
  | "updatedAt"
  | "latestUserMessageAt"
  | "archivedAt"
>;

const SHELL_ACTIVE_STATUSES: ReadonlySet<BotShell["status"]> = new Set([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

export interface BotActivity {
  readonly lastAt: number | null;
  readonly lastTitle: string | null;
  readonly running: boolean;
}

const shellActivityAt = (shell: BotShell): number =>
  Math.max(
    DateTime.toEpochMillis(shell.updatedAt),
    shell.latestUserMessageAt === null ? 0 : DateTime.toEpochMillis(shell.latestUserMessageAt),
  );

/** Aggregates a bot's live thread shells into last-activity and running state. */
export function botActivity(
  bot: Pick<Bot, "threadTag">,
  shells: ReadonlyArray<BotShell>,
): BotActivity {
  let lastAt = -1;
  let lastTitle: string | null = null;
  let running = false;
  for (const shell of shells) {
    if (shell.archivedAt !== null) continue;
    if (!(shell.tags ?? []).includes(bot.threadTag)) continue;
    const at = shellActivityAt(shell);
    if (at > lastAt) {
      lastAt = at;
      lastTitle = shell.title;
    }
    if (shell.activityRunStatus != null || SHELL_ACTIVE_STATUSES.has(shell.status)) running = true;
  }
  return { lastAt: lastAt < 0 ? null : lastAt, lastTitle, running };
}

/** Sidebar order: pinned first, then most recent activity, then name. */
export function sortBotsForSidebar(
  bots: ReadonlyArray<Bot>,
  activity: (bot: Bot) => BotActivity,
): Bot[] {
  return [...bots].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const diff = (activity(b).lastAt ?? -1) - (activity(a).lastAt ?? -1);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  });
}

export function filterBots(bots: ReadonlyArray<Bot>, query: string): Bot[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...bots];
  return bots.filter(
    (bot) => bot.name.toLowerCase().includes(q) || (bot.role ?? "").toLowerCase().includes(q),
  );
}

/** "swe-2-high (devin)"-style label for a model selection. */
export const modelSelectionLabel = (selection: {
  readonly instanceId: string;
  readonly model: string;
}): string => `${selection.model} (${selection.instanceId})`;

/**
 * The preview's model line: the mapped selection's display label, or the source
 * model with a note that the fallback will be used instead.
 */
export function importModelLine(
  candidate: BotImportCandidate,
  fallbackLabel: string,
  resolve: MessageResolver = m,
  selectionLabel: (selection: {
    instanceId: string;
    model: string;
  }) => string = modelSelectionLabel,
): string {
  if (candidate.modelSelection !== undefined) {
    return selectionLabel(candidate.modelSelection);
  }
  const source =
    candidate.sourceModel === undefined ? resolve(msg("Unknown model")) : candidate.sourceModel;
  return resolve(
    msg("{model}, not available here, will use {fallback}", {
      model: source,
      fallback: fallbackLabel,
    }),
  );
}

export const importMemoryLabel = (bytes: number, resolve: MessageResolver = m): string =>
  resolve(msg("{count, plural, =1 {# byte} other {# bytes}}", { count: bytes }));

/** Writes a text file to the user's downloads via a blob anchor. */
export function downloadTextFile(fileName: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
