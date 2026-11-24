import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentId,
  type Bot,
  type ScheduledTask,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT, useLocale, useMessages } from "gt-react";
import { BotIcon, PencilIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { cn, randomUUID } from "../../lib/utils";
import { requestConfirmDialog } from "../../confirmDialog";
import { m } from "../../i18n/messages";
import { readEnvironmentScope } from "../../state/session";
import {
  useConnectedEnvironmentIds,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogPopup } from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SidebarInset } from "../ui/sidebar";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BotEditorDialog } from "./BotEditorDialog";
import { APPROVAL_MODE_RUNTIME_LABELS, botAutomationCount } from "./botPage.logic";
import { scheduleLabel } from "../settings/scheduledTasksSettings.logic";

function botAvatarLabel(bot: Bot): string {
  return bot.avatar?.trim() || (bot.name.trim()[0] ?? "B").toUpperCase();
}

function BotRow(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly tasks: ReadonlyArray<ScheduledTask>;
  readonly timeZone: string | undefined;
  readonly canOperate: boolean;
  readonly onEdit: () => void;
}) {
  const { environmentId, bot, tasks, timeZone, canOperate, onEdit } = props;
  const gt = useGT();
  const messages = useMessages();
  const locale = useLocale();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const navigate = useNavigate();
  const setEnabled = useAtomCommand(serverEnvironment.setBotEnabled, {
    label: "bot enabled",
  });
  const setTaskEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "automation enabled",
  });
  const deleteBot = useAtomCommand(serverEnvironment.deleteBot, { label: "bot delete" });
  const runNow = useAtomCommand(serverEnvironment.runBotNow, { label: "bot run now" });
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"toggle" | "run" | "delete" | null>(null);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const automations = tasks.filter((task) => task.botId === bot.id);
  const automationCount = botAutomationCount(tasks, bot.id);

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

  const requireOperate = () => {
    if (canOperate && readEnvironmentScope(environmentId, AuthOrchestrationOperateScope))
      return true;
    reportFailure(gt("Not permitted"), gt("This session cannot change orchestration settings."));
    return false;
  };

  const toggle = async () => {
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

  const remove = async () => {
    if (busy !== null || !requireOperate()) return;
    const message = `${gt('Delete "{name}"?', { name: bot.name })}\n${
      automationCount === 0
        ? gt("This cannot be undone.")
        : gt("Its {count} automations are deleted too. This cannot be undone.", {
            count: automationCount,
          })
    }`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    setBusy("delete");
    const result = await deleteBot({ environmentId, input: { id: bot.id } });
    setBusy(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not delete bot"), squashAtomCommandFailure(result));
    }
  };

  const run = async () => {
    const text = prompt.trim();
    if (busy !== null || !text) return;
    if (!requireOperate()) return;
    setBusy("run");
    const result = await runNow({
      environmentId,
      input: { id: bot.id, prompt: text, commandId: CommandId.make(randomUUID()) },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure(gt("Could not run bot"), squashAtomCommandFailure(result));
      }
      return;
    }
    setPrompt("");
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId, threadId: result.value.threadId }),
    });
  };

  return (
    <li className="rounded-xl border border-border/60 bg-card/40 px-4 py-3">
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 flex size-9 shrink-0 select-none items-center justify-center rounded-lg bg-muted text-sm font-semibold"
          aria-hidden
        >
          {botAvatarLabel(bot)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{bot.name}</span>
            {!bot.enabled ? (
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-2xs text-muted-foreground">
                <T>Disabled</T>
              </span>
            ) : null}
          </div>
          {bot.description ? (
            <p className="mt-0.5 truncate text-2xs text-muted-foreground">{bot.description}</p>
          ) : null}
          <p className="mt-1 text-2xs text-muted-foreground">
            {bot.modelSelection.model} · {m(APPROVAL_MODE_RUNTIME_LABELS[bot.approvalMode])} ·{" "}
            {gt("{count} automations", { count: automationCount })}
          </p>
          {canOperate ? (
            <form
              className="mt-2 flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void run();
              }}
            >
              <Input
                value={prompt}
                placeholder={gt("Run {name} now…", { name: bot.name })}
                className="h-8 flex-1"
                disabled={busy !== null || !bot.enabled}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="submit"
                      size="icon-sm"
                      variant="outline"
                      aria-label={gt("Run now")}
                      disabled={busy !== null || !bot.enabled || !prompt.trim()}
                    />
                  }
                >
                  <PlayIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>
                  <T>Run now</T>
                </TooltipPopup>
              </Tooltip>
            </form>
          ) : null}
          {automations.length > 0 || canOperate ? (
            <div className="mt-2.5 border-t border-border/50 pt-2">
              <ul className="space-y-1">
                {automations.map((task) => (
                  <li key={task.id} className="flex items-center gap-2 text-2xs">
                    <Switch
                      checked={task.enabled}
                      disabled={busyTaskId !== null || !canOperate}
                      aria-label={gt("Enable {title}", { title: task.title })}
                      onCheckedChange={() => {
                        if (busyTaskId !== null || !requireOperate()) return;
                        setBusyTaskId(task.id);
                        void setTaskEnabled({
                          environmentId,
                          input: { id: task.id, enabled: !task.enabled },
                        }).then((result) => {
                          setBusyTaskId(null);
                          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                            reportFailure(
                              gt("Could not update automation"),
                              squashAtomCommandFailure(result),
                            );
                          }
                        });
                      }}
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
                  search={{ environmentId, botId: bot.id }}
                  className="mt-1.5 inline-flex items-center gap-1 rounded-sm text-2xs text-muted-foreground hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <PlusIcon className="size-3" aria-hidden />
                  <T>Add automation</T>
                </Link>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canOperate ? (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={gt("Edit {name}", { name: bot.name })}
                      onClick={onEdit}
                    />
                  }
                >
                  <PencilIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>
                  <T>Edit</T>
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={gt("Delete {name}", { name: bot.name })}
                      onClick={() => void remove()}
                      disabled={busy !== null}
                    />
                  }
                >
                  <Trash2Icon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup>
                  <T>Delete</T>
                </TooltipPopup>
              </Tooltip>
              <Switch
                checked={bot.enabled}
                onCheckedChange={() => void toggle()}
                disabled={busy !== null}
                aria-label={gt("Enable {name}", { name: bot.name })}
              />
            </>
          ) : null}
        </div>
      </div>
    </li>
  );
}

export function BotsPage() {
  const search = useSearch({ from: "/_chat/bots" });
  const navigate = useNavigate();
  const gt = useGT();
  const messages = useMessages();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedIds = useConnectedEnvironmentIds();
  const { environments } = useEnvironments();
  const connected = environments.filter((environment) =>
    connectedIds.includes(environment.environmentId),
  );
  const asked = search.env === undefined ? null : EnvironmentId.make(search.env);
  const environmentId =
    asked !== null
      ? (connected.find((environment) => environment.environmentId === asked)?.environmentId ??
        null)
      : (connected.find((environment) => environment.environmentId === primaryEnvironmentId)
          ?.environmentId ??
        connected[0]?.environmentId ??
        null);

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
  const canOperate = useAtomValue(
    serverEnvironment.upsertBot.permissionAtom(environmentId ?? EnvironmentId.make("")),
  );
  const [editor, setEditor] = useState<{ bot: Bot | null } | null>(null);
  const tasks = tasksQuery.data?.tasks ?? [];

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="scrollbar-gutter-both flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <WorkspacePageHeader>
          <WorkspaceBreadcrumb ariaLabel={gt("Bots breadcrumb")}>
            <WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbText>
                <T>Bots</T>
              </WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="mx-auto w-full max-w-3xl flex-1 px-4 pb-10">
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
            {canOperate && environmentId !== null ? (
              <Button size="sm" onClick={() => setEditor({ bot: null })}>
                <PlusIcon className="size-3.5" />
                <T>New bot</T>
              </Button>
            ) : null}
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
                    <span className="font-mono text-2xs">{error.folder}</span> · {error.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {botsQuery.data !== null && botsQuery.data.bots.length === 0 ? (
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
            <ul className="space-y-2">
              {botsQuery.data?.bots.map((bot) => (
                <BotRow
                  key={bot.id}
                  environmentId={environmentId ?? EnvironmentId.make("")}
                  bot={bot}
                  tasks={tasks}
                  timeZone={tasksQuery.data?.timeZone}
                  canOperate={canOperate}
                  onEdit={() => setEditor({ bot })}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
      <Dialog open={editor !== null} onOpenChange={(open) => !open && setEditor(null)}>
        <DialogPopup className={cn("sm:max-w-lg")}>
          {editor !== null && environmentId !== null ? (
            <BotEditorDialog
              environmentId={environmentId}
              bot={editor.bot}
              onClose={() => setEditor(null)}
            />
          ) : null}
        </DialogPopup>
      </Dialog>
    </SidebarInset>
  );
}
