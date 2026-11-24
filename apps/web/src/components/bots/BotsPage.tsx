import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  botAvatarOrDefault,
  CommandId,
  EnvironmentId,
  type Bot,
  type OrchestrationV2ThreadShell,
  type ScheduledTask,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { DateTime } from "effect";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT, useLocale, useMessages } from "gt-react";
import {
  BotIcon,
  EllipsisIcon,
  PencilIcon,
  PlusIcon,
  SendHorizonalIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { cn, randomUUID } from "../../lib/utils";
import { requestConfirmDialog } from "../../confirmDialog";
import { m } from "../../i18n/messages";
import { readEnvironmentScope } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogPopup } from "../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BotAvatar } from "./BotAvatar";
import { BotEditorDialog } from "./BotEditorDialog";
import { BotProfileForm } from "./BotProfileForm";
import { APPROVAL_MODE_RUNTIME_LABELS, botActivity, botAutomationCount } from "./botPage.logic";
import { scheduleLabel } from "../settings/scheduledTasksSettings.logic";
import { useBotsEnvironment } from "./useBotsEnvironment";

const reportFailure = (title: string, error: unknown) => {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description:
        error instanceof Error ? (thrownErrorMessage(error, m) ?? error.message) : String(error),
    }),
  );
};

function useBotActions(environmentId: EnvironmentId, canOperate: boolean) {
  const gt = useGT();
  const setEnabled = useAtomCommand(serverEnvironment.setBotEnabled, {
    label: "bot enabled",
  });
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "automation enabled",
  });
  const deleteBot = useAtomCommand(serverEnvironment.deleteBot, { label: "bot delete" });
  const runNow = useAtomCommand(serverEnvironment.runBotNow, { label: "bot run now" });
  const [busy, setBusy] = useState<"toggle" | "run" | "delete" | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const requireOperate = () => {
    if (canOperate && readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return true;
    reportFailure(gt("Not permitted"), gt("This session cannot change orchestration settings."));
    return false;
  };

  const toggle = async (bot: Bot) => {
    if (busy !== null || !requireOperate()) return;
    setBusy("toggle");
    const result = await setEnabled({
      environmentId,
      input: { id: bot.id, enabled: !bot.enabled },
    });
    setBusy(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not update bot"), squashAtomCommandFailure(result));
    }
  };

  const remove = async (bot: Bot, automationCount: number) => {
    if (busy !== null || !requireOperate()) return false;
    const message = `${gt('Delete "{name}"?', { name: bot.name })}\n${
      automationCount === 0
        ? gt("This cannot be undone.")
        : gt("Its {count} automations are deleted too. This cannot be undone.", {
            count: automationCount,
          })
    }`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return false;
    setBusy("delete");
    const result = await deleteBot({ environmentId, input: { id: bot.id } });
    setBusy(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not delete bot"), squashAtomCommandFailure(result));
      return false;
    }
    return result._tag === "Success";
  };

  const run = async (bot: Bot, text: string) => {
    const prompt = text.trim();
    if (busy !== null || !prompt) return null;
    if (!requireOperate()) return null;
    setBusy("run");
    const result = await runNow({
      environmentId,
      input: { id: bot.id, prompt, commandId: CommandId.make(randomUUID()) },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure(gt("Could not run bot"), squashAtomCommandFailure(result));
      }
      return null;
    }
    return result.value.threadId;
  };

  const toggleTask = async (task: ScheduledTask) => {
    if (busyTaskId !== null || !requireOperate()) return;
    setBusyTaskId(task.id);
    const result = await setTaskEnabled({
      environmentId,
      input: { id: task.id, enabled: !task.enabled },
    });
    setBusyTaskId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not update automation"), squashAtomCommandFailure(result));
    }
  };

  return { busy, busyTaskId, toggle, remove, run, toggleTask, requireOperate };
}

function BotAutomations(props: {
  readonly environmentId: EnvironmentId;
  readonly botId: Bot["id"];
  readonly tasks: ReadonlyArray<ScheduledTask>;
  readonly timeZone: string | undefined;
  readonly canOperate: boolean;
  readonly busyTaskId: string | null;
  readonly toggleTask: (task: ScheduledTask) => void;
}) {
  const { environmentId, botId, tasks, timeZone, canOperate, busyTaskId, toggleTask } = props;
  const gt = useGT();
  const messages = useMessages();
  const locale = useLocale();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  if (tasks.length === 0 && !canOperate) return null;
  return (
    <div className="mt-3 border-t border-border/50 pt-2">
      <p className="mb-1.5 text-2xs font-semibold text-muted-foreground">
        <T>Automations</T>
      </p>
      <ul className="space-y-1">
        {tasks.map((task) => (
          <li key={task.id} className="flex items-center gap-2 text-2xs">
            <Switch
              checked={task.enabled}
              disabled={busyTaskId !== null || !canOperate}
              aria-label={gt("Enable {title}", { title: task.title })}
              onCheckedChange={() => void toggleTask(task)}
            />
            <Link
              to="/settings/scheduled-tasks"
              search={{ environmentId, taskId: task.id }}
              className="min-w-0 flex-1 truncate rounded-sm font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            >
              {task.title}
            </Link>
            <span className="shrink-0 text-muted-foreground">
              {task.blockedByBot ??
                task.blockedByPolicy ??
                scheduleLabel(
                  task.schedule,
                  timestampFormat,
                  timeZone,
                  task.nextRunAt,
                  messages,
                  locale,
                )}
            </span>
          </li>
        ))}
      </ul>
      {canOperate ? (
        <Link
          to="/settings/scheduled-tasks"
          search={{ environmentId, botId }}
          className="mt-1.5 inline-flex items-center gap-1 rounded-sm text-2xs text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
        >
          <PlusIcon className="size-3" aria-hidden />
          <T>Add automation</T>
        </Link>
      ) : null}
    </div>
  );
}

function BotCard(props: { readonly bot: Bot; readonly onOpen: () => void }) {
  const { bot, onOpen } = props;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex h-full w-full flex-col items-start gap-2 rounded-xl border border-border/60 bg-card/40 px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <BotAvatar bot={bot} size={56} glow className="shrink-0" />
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{bot.name}</span>
          {bot.role ? (
            <span
              className="truncate text-2xs font-semibold"
              style={{ color: botAvatarOrDefault(bot).color }}
            >
              {bot.role}
            </span>
          ) : null}
        </span>
        {bot.description ? (
          <span className="line-clamp-2 text-2xs text-muted-foreground">{bot.description}</span>
        ) : null}
        <span className="mt-auto text-2xs text-muted-foreground">{bot.modelSelection.model}</span>
      </button>
    </li>
  );
}

function BotDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly shells: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly tasks: ReadonlyArray<ScheduledTask>;
  readonly timeZone: string | undefined;
  readonly canOperate: boolean;
  readonly onEdit: () => void;
  readonly onDeleted: () => void;
}) {
  const { environmentId, bot, shells, tasks, timeZone, canOperate, onEdit, onDeleted } = props;
  const gt = useGT();
  const navigate = useNavigate();
  const { busy, busyTaskId, toggle, remove, run, toggleTask } = useBotActions(
    environmentId,
    canOperate,
  );
  const [prompt, setPrompt] = useState("");
  const automations = tasks.filter((task) => task.botId === bot.id);
  const automationCount = botAutomationCount(tasks, bot.id);
  const activity = botActivity(bot, shells);
  const conversations = shells
    .filter(
      (shell) =>
        shell.archivedAt === null &&
        shell.deletedAt === null &&
        (shell.tags ?? []).includes(bot.threadTag),
    )
    .toSorted((a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt));

  const send = async () => {
    const threadId = await run(bot, prompt);
    if (threadId === null) return;
    setPrompt("");
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId, threadId }),
    });
  };

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex items-center gap-2.5 border-b border-border/50 pb-3">
        <BotAvatar
          bot={bot}
          size={28}
          {...(activity.running ? { state: "working" as const, animated: true } : {})}
        />
        <span className="truncate text-sm font-semibold">{bot.name}</span>
        {bot.role ? (
          <span
            className="truncate rounded-md px-1.5 py-0.5 text-2xs font-semibold"
            style={{
              color: botAvatarOrDefault(bot).color,
              backgroundColor: `${botAvatarOrDefault(bot).color}1f`,
            }}
          >
            {bot.role}
          </span>
        ) : null}
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
          {bot.modelSelection.model}
        </span>
        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
          {m(APPROVAL_MODE_RUNTIME_LABELS[bot.approvalMode])}
        </span>
        <span className="flex-1" />
        {canOperate ? (
          <>
            <Button size="sm" variant="outline" className="lg:hidden" onClick={onEdit}>
              <T>Profile</T>
            </Button>
            <Switch
              checked={bot.enabled}
              onCheckedChange={() => void toggle(bot)}
              disabled={busy !== null}
              aria-label={gt("Enable {name}", { name: bot.name })}
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={gt("Bot actions")}
                    disabled={busy !== null}
                  />
                }
              >
                <EllipsisIcon className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={onEdit}>
                  <PencilIcon className="size-3.5" />
                  <T>Edit profile</T>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => {
                    void remove(bot, automationCount).then((deleted) => {
                      if (deleted) onDeleted();
                    });
                  }}
                >
                  <Trash2Icon className="size-3.5" />
                  <T>Delete</T>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : null}
      </div>

      <div className="flex-1 py-3">
        <p className="mb-1.5 text-2xs font-semibold text-muted-foreground">
          <T>Conversations</T>
        </p>
        {conversations.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-2xs text-muted-foreground">
            <T>No conversations yet. Send a message to start one.</T>
          </p>
        ) : (
          <ul className="space-y-px">
            {conversations.map((shell) => (
              <li key={shell.id}>
                <Link
                  to="/$environmentId/$threadId"
                  params={buildThreadRouteParams({ environmentId, threadId: shell.id })}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="min-w-0 flex-1 truncate text-xs">{shell.title}</span>
                  <span className="shrink-0 text-2xs text-muted-foreground">{shell.status}</span>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {formatRelativeTimeLabel(
                      new Date(DateTime.toEpochMillis(shell.updatedAt)).toISOString(),
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        <BotAutomations
          environmentId={environmentId}
          botId={bot.id}
          tasks={automations}
          timeZone={timeZone}
          canOperate={canOperate}
          busyTaskId={busyTaskId}
          toggleTask={toggleTask}
        />
      </div>

      {canOperate ? (
        <div className="sticky bottom-0 border-t border-border/50 bg-background pb-3 pt-2">
          {!bot.enabled ? (
            <p className="pb-1.5 text-2xs text-muted-foreground">
              <T>Enable this bot to send it a message.</T>
            </p>
          ) : null}
          <div className="flex items-end gap-2">
            <Textarea
              value={prompt}
              placeholder={gt("Message {name}…", { name: bot.name })}
              className="max-h-40 min-h-9 flex-1"
              disabled={busy !== null || !bot.enabled}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <Button
              size="icon-sm"
              aria-label={gt("Send")}
              disabled={busy !== null || !bot.enabled || !prompt.trim()}
              onClick={() => void send()}
            >
              <SendHorizonalIcon className="size-3.5" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function BotsPage() {
  const search = useSearch({ from: "/_chat/bots" });
  const navigate = useNavigate();
  const gt = useGT();
  const messages = useMessages();
  const { connected, environmentId } = useBotsEnvironment(search.env);

  const botsQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.botsLive({ environmentId, input: {} }),
    messages,
  );
  const tasksQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
    messages,
  );
  const shells = useAtomValue(
    environmentThreadShells.environmentThreadsAtom(environmentId ?? EnvironmentId.make("")),
  );
  const canOperate = useAtomValue(
    serverEnvironment.upsertBot.permissionAtom(environmentId ?? EnvironmentId.make("")),
  );
  const [editProfile, setEditProfile] = useState(false);
  const tasks = tasksQuery.data?.tasks ?? [];
  const bots = botsQuery.data?.bots ?? [];
  const selected =
    search.bot === undefined ? null : (bots.find((bot) => bot.id === search.bot) ?? null);
  const createOpen = search.create === true;

  const navigateSearch = (patch: { bot?: string; create?: true }) =>
    void navigate({
      to: "/bots",
      search: { ...(search.env === undefined ? {} : { env: search.env }), ...patch },
      replace: true,
    });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="scrollbar-gutter-both flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          <WorkspacePageHeader>
            <WorkspaceBreadcrumb ariaLabel={gt("Bots breadcrumb")}>
              <WorkspaceBreadcrumbItem>
                <WorkspaceBreadcrumbText>
                  <T>Bots</T>
                </WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
            <span className="flex-1" />
            {canOperate && environmentId !== null ? (
              <Button size="sm" onClick={() => navigateSearch({ create: true })}>
                <PlusIcon className="size-3.5" />
                <T>New bot</T>
              </Button>
            ) : null}
          </WorkspacePageHeader>
          <div className={cn("w-full flex-1 px-4 pb-4", selected === null && "mx-auto max-w-4xl")}>
            <div className="mb-4 flex items-center justify-between gap-3">
              {connected.length > 1 && environmentId !== null ? (
                <Select
                  value={environmentId}
                  onValueChange={(value) =>
                    void navigate({
                      to: "/bots",
                      search: { env: value as string },
                      replace: true,
                    })
                  }
                >
                  <SelectTrigger className="w-56">
                    <SelectValue>
                      {connected.find((environment) => environment.environmentId === environmentId)
                        ?.label ?? environmentId}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {connected.map((environment) => (
                      <SelectItem
                        key={environment.environmentId}
                        value={environment.environmentId}
                        label={environment.label}
                      >
                        {environment.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : (
                <span />
              )}
            </div>

            {botsQuery.error !== null ? (
              <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {botsQuery.error}
              </p>
            ) : null}

            {(botsQuery.data?.loadErrors.length ?? 0) > 0 ? (
              <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                <p className="font-medium">
                  <T>Some bot folders could not be read</T>
                </p>
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                  {botsQuery.data?.loadErrors.map((error) => (
                    <li key={error.folder}>
                      <span className="font-mono text-2xs">{error.folder}</span>: {error.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {selected !== null && environmentId !== null ? (
              <BotDetail
                environmentId={environmentId}
                bot={selected}
                shells={shells}
                tasks={tasks}
                timeZone={tasksQuery.data?.timeZone}
                canOperate={canOperate}
                onEdit={() => setEditProfile(true)}
                onDeleted={() => navigateSearch({})}
              />
            ) : (
              <>
                {botsQuery.data !== null && bots.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border/60 px-6 py-14 text-center">
                    <BotIcon className="size-8 text-muted-foreground/60" aria-hidden />
                    <p className="text-sm font-medium">
                      <T>No bots yet</T>
                    </p>
                    <p className="max-w-sm text-sm text-muted-foreground">
                      <T>
                        A bot is a saved profile that runs as ordinary threads with its own project,
                        model, permissions, and standing instructions.
                      </T>
                    </p>
                  </div>
                ) : (
                  <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {bots.map((bot) => (
                      <BotCard
                        key={bot.id}
                        bot={bot}
                        onOpen={() => navigateSearch({ bot: bot.id })}
                      />
                    ))}
                    {canOperate ? (
                      <li>
                        <button
                          type="button"
                          onClick={() => navigateSearch({ create: true })}
                          className="flex h-full min-h-32 w-full flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/60 px-4 py-3 text-muted-foreground transition-colors hover:border-brand/50 hover:bg-accent/40 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          <PlusIcon className="size-5" />
                          <span className="text-2xs font-medium">
                            <T>New bot</T>
                          </span>
                        </button>
                      </li>
                    ) : null}
                  </ul>
                )}
              </>
            )}
          </div>
        </div>

        {selected !== null && environmentId !== null ? (
          <aside className="hidden w-[340px] shrink-0 flex-col border-l border-border/60 lg:flex">
            <div className="flex items-center justify-between border-b border-border/50 px-4 py-2.5">
              <span className="text-xs font-semibold">
                <T>Bot profile</T>
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <BotProfileForm
                key={selected.id}
                environmentId={environmentId}
                bot={selected}
                variant="panel"
              />
            </div>
          </aside>
        ) : null}
      </div>

      <Dialog open={createOpen} onOpenChange={(open) => !open && navigateSearch({})}>
        <DialogPopup className={cn("sm:max-w-lg")}>
          {createOpen && environmentId !== null ? (
            <BotEditorDialog
              environmentId={environmentId}
              bot={null}
              onClose={() => navigateSearch({})}
              onSaved={(bot) => navigateSearch({ bot: bot.id })}
            />
          ) : null}
        </DialogPopup>
      </Dialog>

      <Dialog open={editProfile} onOpenChange={setEditProfile}>
        <DialogPopup className={cn("sm:max-w-lg")}>
          {editProfile && selected !== null && environmentId !== null ? (
            <BotEditorDialog
              environmentId={environmentId}
              bot={selected}
              onClose={() => setEditProfile(false)}
            />
          ) : null}
        </DialogPopup>
      </Dialog>
    </SidebarInset>
  );
}
