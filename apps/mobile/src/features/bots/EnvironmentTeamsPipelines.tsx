import { useAtomValue } from "@effect/atom-react";
import { CommandId, EnvironmentId, type ProjectId } from "@t3tools/contracts";
import type { Bot, Pipeline, Team, WorkflowQuestion, WorkflowRun } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { readWorkflowQuestion } from "@t3tools/client-runtime/workflows";
import { msg, T, useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, TextInput as RNTextInput, View } from "react-native";

import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import { m } from "../../i18n/messages";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  return result._tag === "Failure" && !isAtomCommandInterrupted(result)
    ? String(squashAtomCommandFailure(result))
    : null;
}

const RUN_STATUS_LABELS: Record<WorkflowRun["status"], string> = {
  running: msg("Running"),
  waiting: msg("Waiting"),
  paused: msg("Paused"),
  completed: msg("Done"),
  stopped: msg("Stopped"),
  skipped: msg("Skipped"),
  cancelled: msg("Cancelled"),
};

function PipelineRunRow(props: {
  readonly environmentId: EnvironmentId;
  readonly run: WorkflowRun;
  readonly question: WorkflowQuestion | undefined;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const canAnswer = useAtomValue(
    serverEnvironment.answerWorkflowQuestion.permissionAtom(props.environmentId),
  );
  const answer = useAtomCommand(serverEnvironment.answerWorkflowQuestion, {
    label: "workflow answer",
    reportFailure: false,
  });
  const choose = async (choice: string) => {
    const question = props.question;
    if (question === undefined || busy) return;
    setBusy(true);
    const result = await answer({
      environmentId: props.environmentId,
      input: { runId: question.runId, name: question.name, choice },
    });
    setBusy(false);
    const message = failureMessage(result);
    if (message !== null) Dialog.alert(gt("Could not answer the question"), message);
  };
  const question = props.question;
  const view = question === undefined ? null : readWorkflowQuestion(question);
  return (
    <View className="gap-1 py-1.5">
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-sm" numberOfLines={1}>
          {props.run.title}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {m(RUN_STATUS_LABELS[props.run.status])}
        </Text>
      </View>
      {view !== null ? (
        <View className="gap-1.5 rounded-lg border border-warning px-2 py-1.5">
          <Text className="text-sm" numberOfLines={4}>
            {view.title}
          </Text>
          <View className="flex-row flex-wrap gap-1.5">
            {view.choices.map((choice) => (
              <Button
                key={choice}
                label={choice}
                tone="secondary"
                size="compact"
                disabled={busy || !canAnswer}
                onPress={() => void choose(choice)}
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function PipelineRow(props: {
  readonly environmentId: EnvironmentId;
  readonly team: Team;
  readonly pipeline: Pipeline;
  readonly bots: ReadonlyArray<Bot>;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly runs: ReadonlyArray<WorkflowRun>;
  readonly questions: ReadonlyArray<WorkflowQuestion>;
  readonly canOperate: boolean;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [task, setTask] = useState("");
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useAtomCommand(serverEnvironment.runPipeline, {
    label: "pipeline run",
    reportFailure: false,
  });
  const lead = props.bots.find((bot) => bot.id === props.team.leadBotId);
  const firstStageBot = props.bots.find((bot) => bot.id === props.pipeline.stages[0]?.botId);
  const pickedProjectId =
    projectId ?? (lead ?? firstStageBot)?.projectId ?? props.projects[0]?.id ?? null;
  const questionByRun = new Map(props.questions.map((question) => [question.runId, question]));

  const start = async () => {
    const text = task.trim();
    if (text === "" || busy || pickedProjectId === null) return;
    setBusy(true);
    const result = await run({
      environmentId: props.environmentId,
      input: {
        pipelineId: props.pipeline.id,
        task: text,
        projectId: pickedProjectId,
        commandId: CommandId.make(uuidv4()),
      },
    });
    setBusy(false);
    const message = failureMessage(result);
    if (message !== null) {
      Dialog.alert(gt("Could not run the pipeline"), message);
      return;
    }
    setTask("");
  };

  return (
    <View className="border-t border-border-subtle px-4 py-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="min-w-0 flex-1 gap-0.5 active:opacity-70"
      >
        <Text textRole="body" className="text-foreground" numberOfLines={1}>
          {props.pipeline.name}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.pipeline.stages.map((stage) => stage.name).join(" → ")}
        </Text>
      </Pressable>
      {open ? (
        <View className="gap-2 pt-1.5">
          <RNTextInput
            value={task}
            onChangeText={setTask}
            placeholder={gt("Describe the task for this pipeline")}
            placeholderTextColor="#888"
            multiline
            editable={!busy && props.canOperate}
            className="rounded-lg border border-border-subtle px-3 py-2 text-sm text-foreground"
          />
          <View className="flex-row items-center gap-2">
            <Menu
              actions={props.projects.map((project) => ({
                id: project.id,
                title: project.title,
                state: project.id === pickedProjectId ? ("on" as const) : ("off" as const),
              }))}
              onPressAction={({ nativeEvent }) => setProjectId(nativeEvent.event as ProjectId)}
            >
              <Pressable className="min-w-0 flex-1 rounded-lg border border-border-subtle px-3 py-2">
                <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                  {props.projects.find((project) => project.id === pickedProjectId)?.title ??
                    gt("Project")}
                </Text>
              </Pressable>
            </Menu>
            <Button
              label={gt("Run")}
              tone="primary"
              disabled={busy || !props.canOperate || task.trim() === "" || pickedProjectId === null}
              onPress={() => void start()}
            />
          </View>
          {props.runs.slice(0, 5).map((entry) => (
            <PipelineRunRow
              key={entry.runId}
              environmentId={props.environmentId}
              run={entry}
              question={questionByRun.get(entry.runId)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The teams and pipelines of one environment, read-only except for runs. */
export function EnvironmentTeamsPipelines(props: {
  readonly environment: { readonly environmentId: EnvironmentId; readonly label: string };
}) {
  const gt = useGT();
  const environmentId = props.environment.environmentId;
  const teams = useEnvironmentQuery(serverEnvironment.teamsLive({ environmentId, input: {} }));
  const pipelines = useEnvironmentQuery(
    serverEnvironment.pipelinesLive({ environmentId, input: {} }),
  );
  const bots = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const workflows = useEnvironmentQuery(
    serverEnvironment.workflowsLive({ environmentId, input: {} }),
  );
  const config = useEnvironmentServerConfig(environmentId);
  const workflowsEnabled = config?.settings.workflowsEnabled === true;
  const canOperate = useAtomValue(serverEnvironment.runPipeline.permissionAtom(environmentId));
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.archivedAt == null,
  );

  const teamList = teams.data?.teams ?? [];
  const pipelineList = pipelines.data?.pipelines ?? [];
  const botList = bots.data?.bots ?? [];
  const runs = workflows.data?.runs ?? [];
  const questions = workflows.data?.questions ?? [];
  const botById = new Map(botList.map((bot) => [bot.id, bot]));
  const loadErrors = [...(teams.data?.loadErrors ?? []), ...(pipelines.data?.loadErrors ?? [])];

  if (teamList.length === 0 && loadErrors.length === 0 && teams.data !== null) return null;

  return (
    <SettingsSection
      title={gt("Teams and pipelines on {label}", { label: props.environment.label })}
    >
      {loadErrors.map((loadError) => (
        <Text
          key={loadError.folder}
          className="border-b border-border-subtle p-4 text-sm text-danger-foreground"
        >
          {gt("{folder}: {message}", { folder: loadError.folder, message: loadError.message })}
        </Text>
      ))}
      {!workflowsEnabled && teams.data !== null ? (
        <Text className="border-b border-border-subtle p-4 text-sm text-foreground-muted">
          <T>Pipelines run on Workflows, a Labs feature. Turn it on on desktop or web.</T>
        </Text>
      ) : null}
      {teamList.map((team) => {
        const lead = team.leadBotId === undefined ? undefined : botById.get(team.leadBotId);
        const own = pipelineList.filter((pipeline) => pipeline.teamId === team.id);
        return (
          <View key={team.id}>
            <View className="gap-0.5 px-4 py-3">
              <Text textRole="body" className="text-foreground" numberOfLines={1}>
                {team.name}
              </Text>
              <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                {[
                  lead === undefined ? null : gt("Led by {name}", { name: lead.name }),
                  m(msg("{count, plural, =1 {# member} other {# members}}"), {
                    count: team.memberBotIds.length,
                  }),
                  team.description ?? null,
                ]
                  .filter((part) => part !== null && part !== "")
                  .join(" · ")}
              </Text>
            </View>
            {own.map((pipeline) => (
              <PipelineRow
                key={pipeline.id}
                environmentId={environmentId}
                team={team}
                pipeline={pipeline}
                bots={botList}
                projects={projects}
                runs={runs.filter(
                  (entry) => entry.key !== null && entry.key.startsWith(`pipeline:${pipeline.id}:`),
                )}
                questions={questions.filter((question) =>
                  runs.some(
                    (entry) =>
                      entry.key !== null &&
                      entry.key.startsWith(`pipeline:${pipeline.id}:`) &&
                      entry.runId === question.runId,
                  ),
                )}
                canOperate={canOperate}
              />
            ))}
          </View>
        );
      })}
      {teams.data !== null ? (
        <Text className="border-t border-border-subtle p-4 text-sm text-foreground-muted">
          <T>Edit teams and pipelines on desktop or web.</T>
        </Text>
      ) : null}
    </SettingsSection>
  );
}
