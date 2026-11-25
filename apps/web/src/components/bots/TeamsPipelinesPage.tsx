import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  type Bot,
  type BotLoadError,
  type EnvironmentId,
  type Pipeline,
  type ProjectId,
  type Team,
  type WorkflowQuestion,
  type WorkflowRun,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { readWorkflowQuestion } from "@t3tools/client-runtime/workflows";
import { Atom } from "effect/reactivity";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import {
  ChevronDownIcon,
  EllipsisIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useState } from "react";

import { cn, randomUUID } from "../../lib/utils";
import { requestConfirmDialog } from "../../confirmDialog";
import { m } from "../../i18n/messages";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useProjects, useServerConfigs } from "../../state/entities";
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
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BotAvatar } from "./BotAvatar";
import { PipelineEditorDialog } from "./PipelineEditorDialog";
import { TeamEditorDialog } from "./TeamEditorDialog";
import { pipelineRuns, stageChainLabel } from "./teamsPipelines.logic";

const DENIED_PERMISSION_ATOM = Atom.make(false).pipe(
  Atom.withLabel("teams-page-permission:denied"),
);

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

const RUN_STATUS_LABELS = {
  running: "Running",
  waiting: "Waiting",
  paused: "Paused",
  completed: "Done",
  stopped: "Stopped",
  skipped: "Skipped",
  cancelled: "Cancelled",
} as const satisfies Record<WorkflowRun["status"], string>;

function runStatusLabel(status: WorkflowRun["status"], gt: ReturnType<typeof useGT>): string {
  switch (status) {
    case "running":
      return gt("Running");
    case "waiting":
      return gt("Waiting");
    case "paused":
      return gt("Paused");
    case "completed":
      return gt("Done");
    case "stopped":
      return gt("Stopped");
    case "skipped":
      return gt("Skipped");
    case "cancelled":
      return gt("Cancelled");
  }
}

function runStatusLine(run: WorkflowRun, gt: ReturnType<typeof useGT>): string {
  if (run.status === "waiting" && run.detail?.startsWith("agent ")) {
    return gt("{step} is working", { step: run.detail.slice("agent ".length) });
  }
  const label = runStatusLabel(run.status, gt);
  return run.detail === null || run.detail === RUN_STATUS_LABELS[run.status]
    ? label
    : `${label}: ${run.detail}`;
}

function QuestionAnswers(props: {
  readonly environmentId: EnvironmentId;
  readonly question: WorkflowQuestion;
}) {
  const { environmentId, question } = props;
  const gt = useGT();
  const view = readWorkflowQuestion(question);
  const [busy, setBusy] = useState(false);
  const canAnswer = useAtomValue(
    serverEnvironment.answerWorkflowQuestion.permissionAtom(environmentId),
  );
  const answer = useAtomCommand(serverEnvironment.answerWorkflowQuestion, {
    label: "workflow answer",
  });
  const choose = async (choice: string) => {
    if (busy) return;
    setBusy(true);
    const result = await answer({
      environmentId,
      input: { runId: question.runId, name: question.name, choice },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not answer the question"), squashAtomCommandFailure(result));
    }
  };
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
      <p className="text-2xs font-medium">{view.title}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {view.choices.map((choice, index) => (
          <Button
            key={choice}
            size="sm"
            variant={index === 0 ? "default" : "outline"}
            disabled={busy || !canAnswer}
            onClick={() => void choose(choice)}
          >
            {choice}
          </Button>
        ))}
      </div>
    </div>
  );
}

function PipelineRunPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly team: Team;
  readonly pipeline: Pipeline;
  readonly bots: ReadonlyArray<Bot>;
  readonly runs: ReadonlyArray<WorkflowRun>;
  readonly questions: ReadonlyArray<WorkflowQuestion>;
  readonly canOperate: boolean;
}) {
  const { environmentId, team, pipeline, bots, runs, questions, canOperate } = props;
  const gt = useGT();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [task, setTask] = useState("");
  const [busy, setBusy] = useState(false);
  const run = useAtomCommand(serverEnvironment.runPipeline, { label: "pipeline run" });
  const lead = bots.find((bot) => bot.id === team.leadBotId);
  const firstStageBot = bots.find((bot) => bot.id === pipeline.stages[0]?.botId);
  const defaultProjectId = (lead ?? firstStageBot)?.projectId ?? projects[0]?.id;
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const pickedProjectId = projectId ?? defaultProjectId;

  const start = async () => {
    const text = task.trim();
    if (text === "" || busy || pickedProjectId === undefined) return;
    setBusy(true);
    const result = await run({
      environmentId,
      input: {
        pipelineId: pipeline.id,
        task: text,
        projectId: pickedProjectId as ProjectId,
        commandId: CommandId.make(randomUUID()),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure(gt("Could not run the pipeline"), squashAtomCommandFailure(result));
      }
      return;
    }
    setTask("");
  };

  const runQuestion = new Map(questions.map((question) => [question.runId, question]));

  return (
    <div className="flex flex-col gap-2 border-t border-border/50 px-3 py-2.5">
      <Textarea
        value={task}
        placeholder={gt("Describe the task for this pipeline")}
        aria-label={gt("Pipeline task")}
        className="max-h-32 min-h-14"
        disabled={busy || !canOperate}
        onChange={(event) => setTask(event.target.value)}
      />
      <div className="flex items-center gap-2">
        <Select value={pickedProjectId} onValueChange={(value) => setProjectId(value ?? undefined)}>
          <SelectTrigger className="min-w-0 flex-1" aria-label={gt("Project")}>
            <SelectValue placeholder={gt("Project")} />
          </SelectTrigger>
          <SelectPopup>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id} label={project.title}>
                {project.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          size="sm"
          disabled={busy || !canOperate || task.trim() === "" || pickedProjectId === undefined}
          onClick={() => void start()}
        >
          <PlayIcon className="size-3.5" />
          <T>Run</T>
        </Button>
      </div>
      {runs.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-1.5">
          {runs.slice(0, 5).map((entry) => {
            const question = runQuestion.get(entry.runId);
            return (
              <li key={entry.runId} className="flex flex-col gap-1.5">
                <Link
                  to="/workflows"
                  search={{ env: environmentId, run: entry.runId }}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="min-w-0 flex-1 truncate text-2xs font-medium">
                    {entry.title}
                  </span>
                  <span className="shrink-0 text-3xs text-muted-foreground">
                    {runStatusLine(entry, gt)}
                  </span>
                  <span className="shrink-0 text-3xs text-muted-foreground">
                    {formatRelativeTimeLabel(entry.startedAt)}
                  </span>
                </Link>
                {question !== undefined ? (
                  <QuestionAnswers environmentId={environmentId} question={question} />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function LoadErrors(props: { readonly errors: ReadonlyArray<BotLoadError> }) {
  if (props.errors.length === 0) return null;
  return (
    <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
      <p className="font-medium">
        <T>Some files could not be read</T>
      </p>
      <ul className="mt-1 list-disc pl-5 text-muted-foreground">
        {props.errors.map((error) => (
          <li key={error.folder}>
            <span className="font-mono text-2xs">{error.folder}</span>: {error.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function TeamsPipelinesPage(props: {
  readonly connected: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly environmentId: EnvironmentId | null;
}) {
  const { connected, environmentId } = props;
  const search = useSearch({ from: "/_chat/bots" });
  const navigate = useNavigate();
  const gt = useGT();
  const messages = useMessages();

  const teamsQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.teamsLive({ environmentId, input: {} }),
    messages,
  );
  const pipelinesQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.pipelinesLive({ environmentId, input: {} }),
    messages,
  );
  const botsQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.botsLive({ environmentId, input: {} }),
    messages,
  );
  const workflowsQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.workflowsLive({ environmentId, input: {} }),
    messages,
  );
  const canOperate = useAtomValue(
    environmentId === null
      ? DENIED_PERMISSION_ATOM
      : serverEnvironment.upsertTeam.permissionAtom(environmentId),
  );
  const canChangeSettings = useAtomValue(
    environmentId === null
      ? DENIED_PERMISSION_ATOM
      : serverEnvironment.updateSettings.permissionAtom(environmentId),
  );
  const configs = useServerConfigs();
  const workflowsEnabled =
    environmentId !== null && configs.get(environmentId)?.settings.workflowsEnabled === true;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "workflows enable",
  });
  const deleteTeam = useAtomCommand(serverEnvironment.deleteTeam, { label: "team delete" });
  const deletePipeline = useAtomCommand(serverEnvironment.deletePipeline, {
    label: "pipeline delete",
  });

  const [editTeam, setEditTeam] = useState<Team | null | "new">(null);
  const [editPipeline, setEditPipeline] = useState<{
    team: Team;
    pipeline: Pipeline | null;
  } | null>(null);
  const [openPipeline, setOpenPipeline] = useState<string | null>(search.pipeline ?? null);
  const [settingsBusy, setSettingsBusy] = useState(false);

  const teams = teamsQuery.data?.teams ?? [];
  const pipelines = pipelinesQuery.data?.pipelines ?? [];
  const bots = botsQuery.data?.bots ?? [];
  const snapshot = workflowsQuery.data;
  const pipelinesOf = (team: Team) => pipelines.filter((pipeline) => pipeline.teamId === team.id);
  const botById = new Map(bots.map((bot) => [bot.id, bot]));

  const turnOnWorkflows = async () => {
    if (environmentId === null || settingsBusy) return;
    setSettingsBusy(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { workflowsEnabled: true } },
    });
    setSettingsBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not turn on Workflows"), squashAtomCommandFailure(result));
    }
  };

  const removeTeam = async (team: Team) => {
    if (environmentId === null) return;
    const message = gt('Delete team "{name}"? This cannot be undone.', { name: team.name });
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    const result = await deleteTeam({ environmentId, input: { id: team.id } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not delete team"), squashAtomCommandFailure(result));
    }
  };

  const removePipeline = async (pipeline: Pipeline) => {
    if (environmentId === null) return;
    const message = gt('Delete pipeline "{name}"? This cannot be undone.', {
      name: pipeline.name,
    });
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (!confirmed) return;
    const result = await deletePipeline({ environmentId, input: { id: pipeline.id } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not delete pipeline"), squashAtomCommandFailure(result));
    }
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="scrollbar-gutter-both flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <WorkspacePageHeader>
          <WorkspaceBreadcrumb ariaLabel={gt("Teams and pipelines breadcrumb")}>
            <WorkspaceBreadcrumbItem>
              <button
                type="button"
                onClick={() =>
                  void navigate({
                    to: "/bots",
                    search: search.env === undefined ? {} : { env: search.env },
                  })
                }
                className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <WorkspaceBreadcrumbText>
                  <T>Bots</T>
                </WorkspaceBreadcrumbText>
              </button>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator>
              <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbSeparator>
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">
                <T>Teams and pipelines</T>
              </h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <span className="flex-1" />
          {canOperate && environmentId !== null ? (
            <Button size="sm" onClick={() => setEditTeam("new")}>
              <PlusIcon className="size-3.5" />
              <T>New team</T>
            </Button>
          ) : null}
        </WorkspacePageHeader>
        <div className="mx-auto w-full max-w-4xl flex-1 px-4 pb-4">
          <div className="mb-4 flex items-center justify-between gap-3">
            {connected.length > 1 && environmentId !== null ? (
              <Select
                value={environmentId}
                onValueChange={(value) => {
                  if (value === null) return;
                  void navigate({
                    to: "/bots",
                    search: { env: value, teams: true },
                    replace: true,
                  });
                }}
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

          {environmentId !== null && !workflowsEnabled ? (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
              <p className="text-sm">
                <T>Pipelines run on Workflows, a Labs feature. Turn it on to run pipelines.</T>
              </p>
              {canChangeSettings ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={settingsBusy}
                  onClick={() => void turnOnWorkflows()}
                >
                  <T>Turn on Workflows</T>
                </Button>
              ) : null}
            </div>
          ) : null}

          {teamsQuery.error !== null ? (
            <p className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {teamsQuery.error}
            </p>
          ) : null}
          <LoadErrors
            errors={[
              ...(teamsQuery.data?.loadErrors ?? []),
              ...(pipelinesQuery.data?.loadErrors ?? []),
            ]}
          />

          {teamsQuery.data !== null && teams.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border/60 px-6 py-14 text-center">
              <UsersIcon className="size-8 text-muted-foreground/60" aria-hidden />
              <p className="text-sm font-medium">
                <T>No teams yet</T>
              </p>
              <p className="max-w-sm text-sm text-muted-foreground">
                <T>
                  A team groups bots under a lead. Its pipelines run member bots in order, with
                  review stages that send weak work back.
                </T>
              </p>
              {canOperate ? (
                <Button size="sm" className="mt-2" onClick={() => setEditTeam("new")}>
                  <PlusIcon className="size-3.5" />
                  <T>New team</T>
                </Button>
              ) : null}
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {teams.map((team) => {
                const lead = team.leadBotId === undefined ? undefined : botById.get(team.leadBotId);
                const own = pipelinesOf(team);
                return (
                  <li
                    key={team.id}
                    className="rounded-xl border border-border/60 bg-card/40 px-4 py-3"
                  >
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => canOperate && setEditTeam(team)}
                      >
                        <span className="truncate text-sm font-semibold">{team.name}</span>
                        {lead !== undefined ? (
                          <span className="flex shrink-0 items-center gap-1 text-2xs text-muted-foreground">
                            <BotAvatar bot={lead} size={14} />
                            {lead.name}
                          </span>
                        ) : null}
                        <span className="shrink-0 text-2xs text-muted-foreground">
                          {gt("{count, plural, =1 {# member} other {# members}}", {
                            count: team.memberBotIds.length,
                          })}
                        </span>
                      </button>
                      {canOperate ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setEditPipeline({ team, pipeline: null })}
                          >
                            <PlusIcon className="size-3.5" />
                            <T>New pipeline</T>
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger
                              render={
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label={gt("Team actions")}
                                />
                              }
                            >
                              <EllipsisIcon className="size-3.5" />
                            </DropdownMenuTrigger>
                            <DropdownMenuContent>
                              <DropdownMenuItem onClick={() => setEditTeam(team)}>
                                <PencilIcon className="size-3.5" />
                                <T>Edit team</T>
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void removeTeam(team)}>
                                <Trash2Icon className="size-3.5" />
                                <T>Delete</T>
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </>
                      ) : null}
                    </div>
                    {team.description !== undefined && team.description !== "" ? (
                      <p className="mt-0.5 line-clamp-2 text-2xs text-muted-foreground">
                        {team.description}
                      </p>
                    ) : null}
                    {own.length === 0 ? (
                      <p className="mt-2 border-t border-border/50 pt-2 text-2xs text-muted-foreground">
                        <T>No pipelines yet.</T>
                      </p>
                    ) : (
                      <ul className="mt-2 flex flex-col border-t border-border/50 pt-1">
                        {own.map((pipeline) => {
                          const open = openPipeline === pipeline.id;
                          const runs =
                            snapshot === null ? [] : pipelineRuns(snapshot.runs, pipeline.id);
                          const questions =
                            snapshot === null
                              ? []
                              : snapshot.questions.filter((question) =>
                                  runs.some((entry) => entry.runId === question.runId),
                                );
                          return (
                            <li key={pipeline.id}>
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  className={cn(
                                    "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring",
                                    open && "bg-accent/40",
                                  )}
                                  onClick={() => setOpenPipeline(open ? null : pipeline.id)}
                                  aria-expanded={open}
                                >
                                  <ChevronDownIcon
                                    className={cn(
                                      "size-3.5 shrink-0 text-muted-foreground transition-transform",
                                      !open && "-rotate-90",
                                    )}
                                  />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-xs font-medium">
                                      {pipeline.name}
                                    </span>
                                    <span className="block truncate text-3xs text-muted-foreground">
                                      {stageChainLabel(pipeline)}
                                    </span>
                                  </span>
                                  {questions.length > 0 ? (
                                    <span className="shrink-0 rounded-full bg-warning/20 px-1.5 py-px text-3xs font-medium text-warning">
                                      <T>Needs you</T>
                                    </span>
                                  ) : null}
                                </button>
                                {canOperate ? (
                                  <DropdownMenu>
                                    <DropdownMenuTrigger
                                      render={
                                        <Button
                                          size="icon-xs"
                                          variant="ghost"
                                          aria-label={gt("Pipeline actions")}
                                        />
                                      }
                                    >
                                      <EllipsisIcon className="size-3.5" />
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent>
                                      <DropdownMenuItem
                                        onClick={() => setEditPipeline({ team, pipeline })}
                                      >
                                        <PencilIcon className="size-3.5" />
                                        <T>Edit pipeline</T>
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        onClick={() => void removePipeline(pipeline)}
                                      >
                                        <Trash2Icon className="size-3.5" />
                                        <T>Delete</T>
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                ) : null}
                              </div>
                              {open && environmentId !== null ? (
                                <PipelineRunPanel
                                  environmentId={environmentId}
                                  team={team}
                                  pipeline={pipeline}
                                  bots={bots}
                                  runs={runs}
                                  questions={questions}
                                  canOperate={canOperate}
                                />
                              ) : null}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <Dialog open={editTeam !== null} onOpenChange={(open) => !open && setEditTeam(null)}>
        <DialogPopup className="sm:max-w-lg">
          {editTeam !== null && environmentId !== null ? (
            <TeamEditorDialog
              environmentId={environmentId}
              team={editTeam === "new" ? null : editTeam}
              bots={bots}
              onClose={() => setEditTeam(null)}
            />
          ) : null}
        </DialogPopup>
      </Dialog>

      <Dialog open={editPipeline !== null} onOpenChange={(open) => !open && setEditPipeline(null)}>
        <DialogPopup className="sm:max-w-xl">
          {editPipeline !== null && environmentId !== null ? (
            <PipelineEditorDialog
              environmentId={environmentId}
              team={editPipeline.team}
              pipeline={editPipeline.pipeline}
              members={editPipeline.team.memberBotIds
                .map((id) => botById.get(id))
                .filter((bot): bot is Bot => bot !== undefined)}
              onClose={() => setEditPipeline(null)}
            />
          ) : null}
        </DialogPopup>
      </Dialog>
    </SidebarInset>
  );
}
