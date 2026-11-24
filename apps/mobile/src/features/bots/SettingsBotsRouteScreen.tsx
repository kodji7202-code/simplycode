import { msg, T, useGT } from "gt-react-native";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import {
  BOT_SOUL_MAX_BYTES,
  BotId,
  CommandId,
  EnvironmentId,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import type { Bot, BotApprovalMode, BotUpsertInput, ModelSelection } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { scheduledTaskWorktreeBaseRef } from "@t3tools/client-runtime/scheduled-task-worktree";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useState } from "react";
import { Pressable, TextInput as RNTextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MenuAction } from "@react-native-menu/menu";

import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { m } from "../../i18n/messages";
import { uuidv4 } from "../../lib/uuid";
import { buildModelOptions } from "../../lib/modelOptions";
import { useEnvironmentServerConfig, useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { usePaginatedBranches } from "../../state/queries";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useSettingsEnvironmentMenu } from "../settings/components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "../settings/settings-environment-filter";
import { settingsTargetsForProject } from "../settings/settings-environment-filter.logic";
import { useScheduledTaskEditor } from "../settings/scheduled-task-editor";
import {
  applyBotToDraft,
  createDraft,
  scheduledTaskDefaultModel,
} from "../settings/scheduledTaskDraft";

const APPROVAL_MODES: ReadonlyArray<{
  readonly id: BotApprovalMode;
  readonly title: string;
  /** What the mode maps to once a run launches, matching the permission-mode names. */
  readonly runtime: string;
}> = [
  { id: "ask", title: msg("Ask"), runtime: msg("Supervised") },
  { id: "auto-safe", title: msg("Auto-safe"), runtime: msg("Auto") },
  { id: "full", title: msg("Full"), runtime: msg("Full access") },
];

function approvalModeTitle(id: BotApprovalMode): string {
  return APPROVAL_MODES.find((mode) => mode.id === id)?.title ?? msg("Ask");
}

function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  return result._tag === "Failure" && !isAtomCommandInterrupted(result)
    ? String(squashAtomCommandFailure(result))
    : null;
}

function Avatar(props: { readonly bot: Bot }) {
  const label = (props.bot.avatar ?? "").trim() || props.bot.name.trim().charAt(0) || "?";
  return (
    <View className="h-9 w-9 items-center justify-center rounded-full bg-grouped-card-secondary">
      <Text className="text-base text-foreground" numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}

export function SettingsBotsRouteScreen() {
  const gt = useGT();
  const navigation = useNavigation<NativeStackNavigationProp<{ SettingsBot: BotRouteParams }>>();
  const insets = useSafeAreaInsets();
  const { availableTargets, selectedTargets, selectedProjectKey, projectGroups } =
    useSettingsEnvironmentFilter();
  const selectedGroup = projectGroups.find((group) => group.key === selectedProjectKey);
  const visibleEnvironments = settingsTargetsForProject(
    selectedTargets,
    selectedProjectKey === null ? null : selectedGroup,
  );
  const environmentMenu = useSettingsEnvironmentMenu();

  const openEditor = (environmentId: EnvironmentId, botId?: BotId) =>
    navigation.navigate("SettingsBot", {
      environmentId: String(environmentId),
      ...(botId !== undefined ? { botId: String(botId) } : {}),
    });

  return (
    <SettingsScreen
      title={gt("Bots")}
      actions={[
        {
          accessibilityLabel: gt("New bot"),
          icon: "plus",
          disabled: visibleEnvironments.length === 0,
          onPress: () => {
            const target = visibleEnvironments[0];
            if (target) openEditor(target.environmentId);
          },
        },
      ]}
      menus={[environmentMenu]}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {visibleEnvironments.length > 0 ? (
          visibleEnvironments.map((environment) => (
            <EnvironmentBots
              key={environment.environmentId}
              environment={environment}
              onEdit={(bot) => openEditor(environment.environmentId, bot.id)}
            />
          ))
        ) : (
          <Text className="px-2 text-base text-foreground-muted">
            {availableTargets.length === 0
              ? gt("Connect an environment to view and create bots.")
              : gt("No environments match these filters. Change the filter above.")}
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function EnvironmentBots(props: {
  readonly environment: { readonly environmentId: EnvironmentId; readonly label: string };
  readonly onEdit: (bot: Bot) => void;
}) {
  const gt = useGT();
  const environmentId = props.environment.environmentId;
  const { startEditor } = useScheduledTaskEditor();
  const navigation = useNavigation<NativeStackNavigationProp<BotScreenRoutes>>();
  const bots = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const config = useEnvironmentServerConfig(environmentId);
  const canOperate = useAtomValue(serverEnvironment.upsertBot.permissionAtom(environmentId));
  const setEnabled = useAtomCommand(serverEnvironment.setBotEnabled, {
    label: "bot enabled",
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.deleteBot, {
    label: "bot delete",
    reportFailure: false,
  });
  const runNow = useAtomCommand(serverEnvironment.runBotNow, {
    label: "bot run",
    reportFailure: false,
  });
  const selectDetail = useSelectWorkspaceDetail();

  const automationCount = (botId: BotId) =>
    tasks.data?.tasks.filter((task) => task.botId === botId).length ?? 0;

  const runBot = async (bot: Bot, prompt: string) => {
    const result = await runNow({
      environmentId,
      input: { id: bot.id, prompt, commandId: CommandId.make(uuidv4()) },
    });
    const message = failureMessage(result);
    if (message !== null || result._tag !== "Success") {
      Dialog.alert(gt("Could not run bot"), message ?? gt("Try again."));
      return;
    }
    selectDetail({
      name: "Thread",
      params: {
        environmentId: String(environmentId),
        threadId: String(result.value.threadId),
      },
    });
  };

  const act = async (bot: Bot, action: "toggle" | "delete") => {
    const result =
      action === "toggle"
        ? await setEnabled({ environmentId, input: { id: bot.id, enabled: !bot.enabled } })
        : await remove({ environmentId, input: { id: bot.id } });
    const message = failureMessage(result);
    if (message !== null) {
      Dialog.alert(
        action === "toggle" ? gt("Could not update bot") : gt("Could not delete bot"),
        message,
      );
    }
  };

  return (
    <SettingsSection
      title={props.environment.label}
      titleIcon={
        <EnvironmentMachineSymbol
          kind={resolveEnvironmentMachineKind(config)}
          size={16}
          tintColorClassName="accent-foreground-muted"
        />
      }
    >
      {bots.error ? (
        <Text className="p-4 text-base text-danger-foreground">{bots.error}</Text>
      ) : !bots.data ? (
        <Text className="p-4 text-base text-foreground-muted">
          <T>Loading bots…</T>
        </Text>
      ) : (
        <>
          {bots.data.loadErrors.map((loadError) => (
            <Text
              key={loadError.folder}
              className="border-b border-border-subtle p-4 text-sm text-danger-foreground"
            >
              {gt("{folder}: {message}", {
                folder: loadError.folder,
                message: loadError.message,
              })}
            </Text>
          ))}
          {bots.data.bots.length === 0 && bots.data.loadErrors.length === 0 ? (
            <Text className="p-4 text-base text-foreground-muted">
              <T>No bots yet.</T>
            </Text>
          ) : null}
          {bots.data.bots.map((bot, index) => (
            <View
              key={bot.id}
              className={
                index === 0
                  ? "flex-row items-start gap-2 px-4 py-3"
                  : "flex-row items-start gap-2 border-t border-border-subtle px-4 py-3"
              }
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={gt("Edit {name}", { name: bot.name })}
                onPress={() => props.onEdit(bot)}
                className="min-w-0 flex-1 flex-row items-start gap-2 active:opacity-70"
              >
                <Avatar bot={bot} />
                <View className="min-w-0 flex-1 gap-1">
                  <Text textRole="body" className="text-foreground" numberOfLines={1}>
                    {bot.name}
                  </Text>
                  {bot.description?.trim() ? (
                    <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                      {bot.description}
                    </Text>
                  ) : null}
                  <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                    {[
                      bot.modelSelection.model,
                      m(approvalModeTitle(bot.approvalMode)),
                      automationCount(bot.id) === 0
                        ? m(msg("No automations"))
                        : m(
                            msg(
                              "{count, plural, one {{count} automation} other {{count} automations}}",
                            ),
                            { count: automationCount(bot.id) },
                          ),
                    ].join(" · ")}
                  </Text>
                  {bot.enabled ? null : (
                    <Text className="text-sm text-foreground-muted">
                      <T>Disabled</T>
                    </Text>
                  )}
                </View>
              </Pressable>
              <ThemedSwitch
                value={bot.enabled}
                disabled={!canOperate}
                onValueChange={() => {
                  if (!canOperate) return;
                  void act(bot, "toggle");
                }}
              />
              <Menu
                actions={[
                  { id: "edit", title: gt("Edit") },
                  { id: "automation", title: gt("Add automation") },
                  { id: "run", title: gt("Run now"), attributes: { disabled: !canOperate } },
                  {
                    id: "delete",
                    title: gt("Delete"),
                    attributes: { destructive: true, disabled: !canOperate },
                  },
                ]}
                onPressAction={({ nativeEvent }) => {
                  const action = nativeEvent.event;
                  if (action === "edit") {
                    props.onEdit(bot);
                  } else if (action === "automation") {
                    startEditor({
                      environmentId,
                      environmentLabel: props.environment.label,
                      draft: applyBotToDraft(createDraft(null, null), bot),
                    });
                    navigation.navigate("SettingsScheduledTaskNew");
                  } else if (action === "run") {
                    Dialog.prompt({
                      title: gt("Run {name}", { name: bot.name }),
                      placeholder: gt("What should the bot do?"),
                      initialValue: "",
                      confirmText: gt("Run"),
                      onConfirm: (value) => {
                        const prompt = value.trim();
                        if (prompt.length > 0) void runBot(bot, prompt);
                      },
                    });
                  } else if (action === "delete") {
                    const count = automationCount(bot.id);
                    Dialog.confirm({
                      title: gt("Delete bot?"),
                      message:
                        count === 0
                          ? gt("“{name}” will be deleted.", { name: bot.name })
                          : gt(
                              "“{name}” and its {count, plural, one {{count} automation} other {{count} automations}} will be deleted.",
                              { name: bot.name, count },
                            ),
                      confirmText: gt("Delete"),
                      destructive: true,
                      onConfirm: () => void act(bot, "delete"),
                    });
                  }
                }}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={gt("{name} actions", { name: bot.name })}
                  className="min-h-11 min-w-11 items-center justify-center active:opacity-70"
                >
                  <SymbolView
                    name="ellipsis"
                    size={18}
                    tintColorClassName="accent-foreground-muted"
                    type="monochrome"
                  />
                </Pressable>
              </Menu>
            </View>
          ))}
        </>
      )}
    </SettingsSection>
  );
}

type BotScreenRoutes = {
  SettingsScheduledTaskNew: undefined;
};

export type BotRouteParams = {
  readonly environmentId: string;
  readonly botId?: string;
};

type BotDraft = {
  readonly name: string;
  readonly avatar: string;
  readonly description: string;
  readonly projectId: Bot["projectId"] | null;
  readonly workspace: "root" | "worktree" | "existing_worktree";
  readonly checkoutPath: string;
  readonly modelSelection: ModelSelection | null;
  readonly approvalMode: BotApprovalMode;
  readonly soul: string | null;
  readonly maxSteps: string;
  readonly maxCost: string;
};

function draftForNewBot(
  projectId: Bot["projectId"] | null,
  model: ModelSelection | null,
): BotDraft {
  return {
    name: "",
    avatar: "",
    description: "",
    projectId,
    workspace: "worktree",
    checkoutPath: "",
    modelSelection: model,
    approvalMode: "ask",
    soul: "",
    maxSteps: "",
    maxCost: "",
  };
}

function draftForBot(bot: Bot, soul: string): BotDraft {
  return {
    name: bot.name,
    avatar: bot.avatar ?? "",
    description: bot.description ?? "",
    projectId: bot.projectId,
    workspace: bot.workspaceStrategy.type,
    checkoutPath:
      bot.workspaceStrategy.type === "existing_worktree" ? bot.workspaceStrategy.worktreePath : "",
    modelSelection: bot.modelSelection,
    approvalMode: bot.approvalMode,
    soul,
    maxSteps: bot.limits.maxStepsPerRun === undefined ? "" : String(bot.limits.maxStepsPerRun),
    maxCost: bot.limits.maxCostUsd === undefined ? "" : String(bot.limits.maxCostUsd),
  };
}

function FormField(props: {
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly multiline?: boolean;
  readonly disabled?: boolean;
  readonly borderTop?: boolean;
  readonly keyboardType?: "default" | "decimal-pad";
  readonly maxLength?: number;
  readonly onChange: (value: string) => void;
}) {
  return (
    <View
      className={
        props.borderTop ? "gap-1 border-t border-border-subtle px-4 py-3" : "gap-1 px-4 py-3"
      }
    >
      <Text textRole="footnote" className="text-foreground-muted">
        {props.label}
      </Text>
      <RNTextInput
        value={props.value}
        placeholder={props.placeholder}
        multiline={props.multiline}
        editable={!props.disabled}
        keyboardType={props.keyboardType ?? "default"}
        maxLength={props.maxLength}
        className="text-base text-foreground"
      />
    </View>
  );
}

function SelectRow(props: {
  readonly label: string;
  readonly value: string;
  readonly actions: MenuAction[];
  readonly onSelect: (id: string) => void;
  readonly borderTop?: boolean;
  readonly disabled?: boolean;
}) {
  const gt = useGT();
  const value = (
    <>
      <Text
        textRole="footnote"
        className="min-w-0 flex-1 text-right text-foreground-muted"
        numberOfLines={1}
      >
        {props.value}
      </Text>
      <SymbolView
        name="chevron.down"
        size={14}
        tintColorClassName="accent-chevron"
        type="monochrome"
      />
    </>
  );
  const rowClass = props.borderTop
    ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3"
    : "min-h-14 flex-row items-center gap-3 px-4 py-3";
  if (props.disabled || props.actions.length === 0) {
    return (
      <View className={rowClass}>
        <Text textRole="body" className="text-foreground">
          {props.label}
        </Text>
        {value}
      </View>
    );
  }
  return (
    <Menu
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt("{label}, {value}", {
          label: props.label,
          value: props.value,
        })}
        className={`${rowClass} active:opacity-70`}
      >
        <Text textRole="body" className="text-foreground">
          {props.label}
        </Text>
        {value}
      </Pressable>
    </Menu>
  );
}

export function SettingsBotRouteScreen({ route }: StaticScreenProps<BotRouteParams>) {
  const gt = useGT();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentIdParam =
    typeof route.params.environmentId === "string"
      ? route.params.environmentId
      : route.params.environmentId?.[0];
  const environmentId = EnvironmentId.make(environmentIdParam ?? "");
  const botIdParam =
    typeof route.params.botId === "string" ? route.params.botId : route.params.botId?.[0];
  const botId = botIdParam !== undefined ? BotId.make(botIdParam) : null;
  const existing = useEnvironmentQuery(
    botId === null ? null : serverEnvironment.bot({ environmentId, input: { id: botId } }),
  );
  const config = useEnvironmentServerConfig(environmentId);
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.archivedAt == null,
  );
  const [draft, setDraft] = useState<BotDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const selectDetail = useSelectWorkspaceDetail();
  const canOperate = useAtomValue(serverEnvironment.upsertBot.permissionAtom(environmentId));
  const upsert = useAtomCommand(serverEnvironment.upsertBot, {
    label: "bot upsert",
    reportFailure: false,
  });
  const remove = useAtomCommand(serverEnvironment.deleteBot, {
    label: "bot delete",
    reportFailure: false,
  });
  const runNow = useAtomCommand(serverEnvironment.runBotNow, {
    label: "bot run",
    reportFailure: false,
  });
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );

  const seeded =
    draft ??
    (botId === null
      ? draftForNewBot(
          projects[0]?.id ?? null,
          scheduledTaskDefaultModel(config, projects[0] ?? null),
        )
      : existing.data
        ? draftForBot(existing.data.bot, existing.data.soul)
        : null);
  const form = seeded;

  const project = projects.find((entry) => entry.id === form?.projectId) ?? null;
  const automaticBaseRefs = usePaginatedBranches({
    environmentId,
    cwd: form?.workspace === "worktree" ? (project?.workspaceRoot ?? null) : null,
    query: "",
  });
  const modelOptions = buildModelOptions(
    config,
    form?.modelSelection ?? null,
    undefined,
    form?.projectId ?? null,
  );
  const soulBytes = new TextEncoder().encode(form?.soul ?? "").length;
  const automationCount =
    botId === null ? 0 : (tasks.data?.tasks.filter((task) => task.botId === botId).length ?? 0);

  const set = (patch: Partial<BotDraft>) =>
    setDraft((current) => {
      const base = current ?? seeded;
      return base === null ? null : { ...base, ...patch };
    });

  const save = async () => {
    if (!form) return;
    const name = form.name.trim();
    const soul = form.soul ?? "";
    const maxSteps = form.maxSteps.trim();
    const maxCost = form.maxCost.trim();
    const stepsNumber = maxSteps === "" ? undefined : Number(maxSteps);
    const costNumber = maxCost === "" ? undefined : Number(maxCost);
    if (!name || !form.projectId || !form.modelSelection) {
      Dialog.alert(gt("Incomplete bot"), gt("Add a name, project, and model before saving."));
      return;
    }
    if (soulBytes > BOT_SOUL_MAX_BYTES) {
      Dialog.alert(
        gt("Standing instructions too long"),
        gt("Keep them under {max} bytes.", { max: BOT_SOUL_MAX_BYTES }),
      );
      return;
    }
    if (
      (stepsNumber !== undefined && (!Number.isInteger(stepsNumber) || stepsNumber < 1)) ||
      (costNumber !== undefined && (!Number.isFinite(costNumber) || costNumber <= 0))
    ) {
      Dialog.alert(gt("Invalid limits"), gt("Limits must be positive numbers, or blank."));
      return;
    }
    const input: BotUpsertInput = {
      ...(botId !== null ? { id: botId } : {}),
      name,
      ...(form.avatar.trim() ? { avatar: form.avatar.trim() } : {}),
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
      enabled: existing.data?.bot.enabled ?? true,
      projectId: form.projectId,
      workspaceStrategy:
        form.workspace === "root"
          ? { type: "root" }
          : form.workspace === "existing_worktree"
            ? { type: "existing_worktree", worktreePath: form.checkoutPath.trim() }
            : {
                type: "worktree",
                baseRef: scheduledTaskWorktreeBaseRef("", automaticBaseRefs.refs),
              },
      modelSelection: form.modelSelection,
      approvalMode: form.approvalMode,
      interactionMode: existing.data?.bot.interactionMode ?? "default",
      limits: {
        ...(stepsNumber !== undefined ? { maxStepsPerRun: stepsNumber } : {}),
        ...(costNumber !== undefined ? { maxCostUsd: costNumber } : {}),
      },
      ...(botId === null || soul !== existing.data?.soul ? { soul } : {}),
    };
    setSaving(true);
    const result = await upsert({ environmentId, input });
    setSaving(false);
    const message = failureMessage(result);
    if (message !== null) {
      Dialog.alert(gt("Could not save bot"), message);
      return;
    }
    navigation.goBack();
  };

  const runBot = async (prompt: string) => {
    if (botId === null) return;
    const result = await runNow({
      environmentId,
      input: { id: botId, prompt, commandId: CommandId.make(uuidv4()) },
    });
    const message = failureMessage(result);
    if (message !== null || result._tag !== "Success") {
      Dialog.alert(gt("Could not run bot"), message ?? gt("Try again."));
      return;
    }
    selectDetail({
      name: "Thread",
      params: { environmentId: String(environmentId), threadId: String(result.value.threadId) },
    });
  };

  const deleteBot = () => {
    if (botId === null) return;
    Dialog.confirm({
      title: gt("Delete bot?"),
      message:
        automationCount === 0
          ? gt("“{name}” will be deleted.", { name: form?.name ?? botId })
          : gt(
              "“{name}” and its {count, plural, one {{count} automation} other {{count} automations}} will be deleted.",
              { name: form?.name ?? botId, count: automationCount },
            ),
      confirmText: gt("Delete"),
      destructive: true,
      onConfirm: () => {
        void (async () => {
          const result = await remove({ environmentId, input: { id: botId } });
          const message = failureMessage(result);
          if (message !== null) {
            Dialog.alert(gt("Could not delete bot"), message);
            return;
          }
          navigation.goBack();
        })();
      },
    });
  };

  return (
    <SettingsScreen title={botId === null ? gt("New bot") : gt("Edit bot")}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {botId !== null && existing.error ? (
          <Text className="px-1 text-base text-danger-foreground">{existing.error}</Text>
        ) : null}
        {botId !== null && existing.data === null && existing.error === null ? (
          <Text className="px-1 text-base text-foreground-muted">
            <T>Loading bot…</T>
          </Text>
        ) : form ? (
          <>
            <SettingsSection>
              <FormField
                label={gt("Name")}
                value={form.name}
                placeholder={gt("Release bot")}
                disabled={!canOperate || saving}
                maxLength={100}
                onChange={(name) => set({ name })}
              />
              <FormField
                label={gt("Avatar")}
                value={form.avatar}
                placeholder={gt("Emoji or initials")}
                disabled={!canOperate || saving}
                maxLength={8}
                borderTop
                onChange={(avatar) => set({ avatar })}
              />
              <FormField
                label={gt("Description")}
                value={form.description}
                disabled={!canOperate || saving}
                multiline
                borderTop
                onChange={(description) => set({ description })}
              />
            </SettingsSection>
            <SettingsSection title={gt("Runs", { $context: "section heading: how the bot runs" })}>
              <SelectRow
                label={gt("Project")}
                value={project?.title ?? gt("Choose project")}
                disabled={!canOperate || saving}
                actions={projects.map((entry) => ({
                  id: entry.id,
                  title: entry.title,
                  state: entry.id === form.projectId ? "on" : undefined,
                }))}
                onSelect={(id) => {
                  const selected = projects.find((entry) => entry.id === id);
                  if (!selected) return;
                  set({
                    projectId: selected.id,
                    modelSelection: scheduledTaskDefaultModel(config, selected),
                  });
                }}
              />
              <SelectRow
                label={gt("Workspace")}
                borderTop
                value={
                  form.workspace === "root"
                    ? gt("Project folder")
                    : form.workspace === "existing_worktree"
                      ? gt("Existing checkout")
                      : gt("New worktree")
                }
                disabled={!canOperate || saving}
                actions={(["root", "worktree", "existing_worktree"] as const).map((mode) => ({
                  id: mode,
                  title:
                    mode === "root"
                      ? gt("Project folder")
                      : mode === "existing_worktree"
                        ? gt("Existing checkout")
                        : gt("New worktree"),
                  state: mode === form.workspace ? "on" : undefined,
                }))}
                onSelect={(id) => {
                  if (id === "root" || id === "worktree" || id === "existing_worktree") {
                    set({ workspace: id });
                  }
                }}
              />
              {form.workspace === "existing_worktree" ? (
                <FormField
                  label={gt("Checkout path")}
                  value={form.checkoutPath}
                  disabled={!canOperate || saving}
                  borderTop
                  onChange={(checkoutPath) => set({ checkoutPath })}
                />
              ) : null}
              <SelectRow
                label={gt("Model")}
                borderTop
                value={
                  modelOptions.find(
                    (option) =>
                      option.selection.instanceId === form.modelSelection?.instanceId &&
                      option.selection.model === form.modelSelection.model,
                  )?.label ??
                  form.modelSelection?.model ??
                  (modelOptions.length ? gt("Choose model") : gt("No models available"))
                }
                disabled={!canOperate || saving}
                actions={modelOptions.map((option, index) => ({
                  id: String(index),
                  title: option.label,
                  state:
                    option.selection.instanceId === form.modelSelection?.instanceId &&
                    option.selection.model === form.modelSelection.model
                      ? "on"
                      : undefined,
                }))}
                onSelect={(id) => {
                  const option = modelOptions[Number(id)];
                  if (option) set({ modelSelection: option.selection });
                }}
              />
              <SelectRow
                label={gt("Approval")}
                borderTop
                value={`${m(approvalModeTitle(form.approvalMode))} · ${m(
                  APPROVAL_MODES.find((mode) => mode.id === form.approvalMode)?.runtime ??
                    msg("Supervised"),
                )}`}
                disabled={!canOperate || saving}
                actions={APPROVAL_MODES.map((mode) => ({
                  id: mode.id,
                  title: `${m(mode.title)} · ${m(mode.runtime)}`,
                  state: mode.id === form.approvalMode ? "on" : undefined,
                }))}
                onSelect={(id) => {
                  if (id === "ask" || id === "auto-safe" || id === "full") {
                    set({ approvalMode: id });
                  }
                }}
              />
            </SettingsSection>
            <SettingsSection
              title={gt("Standing instructions")}
              footer={gt("{bytes} of {max} bytes", {
                bytes: soulBytes,
                max: BOT_SOUL_MAX_BYTES,
              })}
            >
              <FormField
                label={gt("SOUL.md")}
                value={form.soul ?? ""}
                placeholder={gt("Always check the changelog before deploying.")}
                multiline
                disabled={!canOperate || saving}
                onChange={(soul) => set({ soul })}
              />
            </SettingsSection>
            <SettingsSection title={gt("Limits")}>
              <FormField
                label={gt("Max steps per run")}
                value={form.maxSteps}
                keyboardType="decimal-pad"
                disabled={!canOperate || saving}
                onChange={(maxSteps) => set({ maxSteps })}
              />
              <FormField
                label={gt("Max cost (USD)")}
                value={form.maxCost}
                keyboardType="decimal-pad"
                disabled={!canOperate || saving}
                borderTop
                onChange={(maxCost) => set({ maxCost })}
              />
            </SettingsSection>
            <View className="gap-3">
              {canOperate ? (
                <Button
                  label={saving ? gt("Saving…") : gt("Save")}
                  disabled={saving || !form.name.trim() || !form.projectId}
                  onPress={() => void save()}
                />
              ) : null}
              {botId !== null && canOperate ? (
                <>
                  <Button
                    label={gt("Run now")}
                    disabled={saving}
                    onPress={() =>
                      Dialog.prompt({
                        title: gt("Run {name}", { name: form.name }),
                        placeholder: gt("What should the bot do?"),
                        initialValue: "",
                        confirmText: gt("Run"),
                        onConfirm: (value) => {
                          const prompt = value.trim();
                          if (prompt.length > 0) void runBot(prompt);
                        },
                      })
                    }
                  />
                  <Button label={gt("Delete bot")} disabled={saving} onPress={deleteBot} />
                </>
              ) : null}
            </View>
          </>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
