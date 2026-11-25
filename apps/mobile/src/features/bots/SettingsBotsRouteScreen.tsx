import { msg, T, useGT } from "gt-react-native";
import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import {
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  BOT_MEMORY_MAX_BYTES,
  BOT_SOUL_MAX_BYTES,
  BotId,
  CommandId,
  EnvironmentId,
  botAvatarOrDefault,
  resolveEnvironmentMachineKind,
} from "@t3tools/contracts";
import type {
  Bot,
  BotApprovalMode,
  BotAvatar,
  BotAvatarShape,
  BotImportCandidate,
  BotImportScanResult,
  BotImportSource,
  BotSkillName,
  BotUpsertInput,
  ModelSelection,
  ProjectId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { scheduledTaskWorktreeBaseRef } from "@t3tools/client-runtime/scheduled-task-worktree";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  dedupeProviderSkillsByName,
  isProviderSkillUserInvocable,
  resolveProviderSkillsForCwd,
} from "@t3tools/client-runtime/providerSkills";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useState } from "react";
import { Alert, Pressable, TextInput as RNTextInput, View } from "react-native";
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
import { formatBytes } from "../../lib/formatBytes";
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
import { BotAvatarView } from "./BotAvatarView";

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

const AVATAR_SHAPE_LABELS: Record<BotAvatarShape, string> = {
  rectangle: msg("Rectangle"),
  square: msg("Square"),
  circle: msg("Circle"),
  hexagon: msg("Hexagon"),
};

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
  const exportBots = useAtomCommand(serverEnvironment.exportBots, {
    label: "bot export",
    reportFailure: false,
  });
  const [importOpen, setImportOpen] = useState(false);
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

  const shareExport = async (ids: ReadonlyArray<BotId>, includeMemory: boolean) => {
    const first = ids[0];
    if (first === undefined) return;
    const result = await exportBots({
      environmentId,
      input: { ids: [first, ...ids.slice(1)], includeMemory },
    });
    const message = failureMessage(result);
    if (message !== null || result._tag !== "Success") {
      Dialog.alert(gt("Export failed"), message ?? gt("Try again."));
      return;
    }
    try {
      const file = new File(Paths.cache, result.value.fileName);
      if (file.exists) file.delete();
      file.create();
      file.write(result.value.content);
      await Sharing.shareAsync(file.uri);
    } catch (error) {
      Dialog.alert(gt("Export failed"), String(error));
    }
  };

  const exportWithConfirm = (ids: ReadonlyArray<BotId>) => {
    Alert.alert(gt("Export bots"), gt("Include memory (MEMORY.md) in the export?"), [
      { text: gt("With memory"), onPress: () => void shareExport(ids, true) },
      { text: gt("Without memory"), onPress: () => void shareExport(ids, false) },
      { text: gt("Cancel"), style: "cancel" },
    ]);
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
                <BotAvatarView bot={bot} size={36} />
                <View className="min-w-0 flex-1 gap-1">
                  <Text textRole="body" className="text-foreground" numberOfLines={1}>
                    {bot.name}
                  </Text>
                  {[bot.role, bot.description].some((value) => value?.trim()) ? (
                    <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                      {[bot.role, bot.description].filter((value) => value?.trim()).join(" · ")}
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
                  { id: "export", title: gt("Export bot") },
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
                  } else if (action === "export") {
                    exportWithConfirm([bot.id]);
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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Import bots")}
            onPress={() => setImportOpen((open) => !open)}
            className="min-h-11 flex-row items-center gap-2 border-t border-border-subtle px-4 py-3 active:opacity-70"
          >
            <Text textRole="body" className="flex-1 text-foreground">
              <T>Import bots</T>
            </Text>
            <SymbolView
              name={importOpen ? "chevron.up" : "chevron.down"}
              size={14}
              tintColorClassName="accent-foreground-muted"
              type="monochrome"
            />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gt("Export all bots")}
            onPress={() => exportWithConfirm((bots.data?.bots ?? []).map((bot) => bot.id))}
            className="min-h-11 flex-row items-center border-t border-border-subtle px-4 py-3 active:opacity-70"
          >
            <Text textRole="body" className="flex-1 text-foreground">
              <T>Export all bots</T>
            </Text>
          </Pressable>
          {importOpen ? (
            <ImportBotsPanel
              environmentId={environmentId}
              onImported={(imported) => {
                setImportOpen(false);
                const first = imported[0];
                if (first !== undefined) props.onEdit(first);
              }}
            />
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

type ImportSourceKind = "openbot" | "openmausbot" | "folder" | "package";

function ImportBotsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly onImported: (bots: ReadonlyArray<Bot>) => void;
}) {
  const gt = useGT();
  const environmentId = props.environmentId;
  const scanBotImport = useAtomCommand(serverEnvironment.scanBotImport, {
    label: "bot import scan",
    reportFailure: false,
  });
  const applyBotImport = useAtomCommand(serverEnvironment.applyBotImport, {
    label: "bot import apply",
    reportFailure: false,
  });
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.archivedAt == null,
  );

  const [sourceKind, setSourceKind] = useState<ImportSourceKind>("openbot");
  const [folderPath, setFolderPath] = useState("");
  const [packageContent, setPackageContent] = useState<string | null>(null);
  const [packageName, setPackageName] = useState<string | null>(null);
  const [result, setResult] = useState<BotImportScanResult | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [include, setInclude] = useState({ memory: true, skills: true, automations: true });
  const [projectId, setProjectId] = useState<ProjectId | null>(null);
  const [busy, setBusy] = useState(false);

  const modelOptions = providers.flatMap((provider) =>
    provider.models.map((model) => ({
      key: `${provider.instanceId}|${model.slug}`,
      label: `${model.name} (${provider.instanceId})`,
      selection: { instanceId: provider.instanceId, model: model.slug } satisfies ModelSelection,
    })),
  );
  const [fallbackKey, setFallbackKey] = useState(modelOptions[0]?.key ?? "");
  const fallback =
    modelOptions.find((option) => option.key === fallbackKey)?.selection ??
    modelOptions[0]?.selection;

  // "SWE-2 · Devin" for models this server knows; the raw slug when it doesn't.
  const selectionLabel = (selection: { instanceId: string; model: string }): string => {
    const provider = providers.find((item) => item.instanceId === selection.instanceId);
    const model = provider?.models.find((item) => item.slug === selection.model);
    return provider !== undefined && model !== undefined
      ? `${model.name} · ${resolveProviderInstanceDisplayName(provider)}`
      : `${selection.model} (${selection.instanceId})`;
  };
  const fallbackLabel = fallback === undefined ? gt("no model") : selectionLabel(fallback);
  const selectedProjectId = projectId ?? projects[0]?.id ?? null;

  const source = (): BotImportSource | null => {
    if (sourceKind === "openbot") return { type: "openbot" };
    if (sourceKind === "openmausbot") return { type: "openmausbot" };
    if (sourceKind === "folder") {
      return folderPath.trim() === "" ? null : { type: "folder", path: folderPath.trim() };
    }
    return packageContent === null ? null : { type: "package", content: packageContent };
  };

  const runScan = async (src: BotImportSource) => {
    setBusy(true);
    setResult(null);
    const next = await scanBotImport({ environmentId, input: { source: src } });
    setBusy(false);
    const message = failureMessage(next);
    if (message !== null || next._tag !== "Success") {
      Dialog.alert(gt("Could not scan source"), message ?? gt("Try again."));
      return;
    }
    setResult(next.value);
    setChecked(new Set(next.value.candidates.map((candidate) => candidate.key)));
  };

  const scan = () => {
    const src = source();
    if (src !== null) void runScan(src);
  };

  // Local-install sources scan as soon as they are picked; folder waits for Scan.
  const pickSourceKind = (kind: ImportSourceKind) => {
    setSourceKind(kind);
    setResult(null);
    if (kind === "openbot") void runScan({ type: "openbot" });
    else if (kind === "openmausbot") void runScan({ type: "openmausbot" });
  };

  const pickPackage = async () => {
    const { getDocumentAsync } = await import("expo-document-picker");
    const picked = await getDocumentAsync({ copyToCacheDirectory: true });
    const asset = picked.canceled ? null : (picked.assets[0] ?? null);
    if (asset === null) return;
    try {
      const content = await new File(asset.uri).text();
      setPackageContent(content);
      setPackageName(asset.name);
      void runScan({ type: "package", content });
    } catch (error) {
      Dialog.alert(gt("Could not read file"), String(error));
    }
  };

  const apply = async () => {
    const src = source();
    if (src === null || fallback === undefined || selectedProjectId === null) return;
    setBusy(true);
    const next = await applyBotImport({
      environmentId,
      input: {
        source: src,
        keys: [...checked],
        projectId: selectedProjectId,
        fallbackModelSelection: fallback,
        include,
      },
    });
    setBusy(false);
    const message = failureMessage(next);
    if (message !== null || next._tag !== "Success") {
      Dialog.alert(gt("Import failed"), message ?? gt("Try again."));
      return;
    }
    const warnings = next.value.warnings;
    if (warnings.length > 0) {
      Dialog.alert(
        gt("Import warnings"),
        [
          ...warnings.slice(0, 3),
          ...(warnings.length > 3 ? [gt("and {count} more", { count: warnings.length - 3 })] : []),
        ].join("\n"),
      );
    }
    props.onImported(next.value.bots);
  };

  const candidates = result?.candidates ?? [];

  return (
    <View className="gap-2 border-t border-border-subtle px-4 py-3">
      <SelectRow
        label={gt("Source")}
        value={
          sourceKind === "openbot"
            ? gt("OpenBot (this computer)")
            : sourceKind === "openmausbot"
              ? gt("OpenMausBot (this computer)")
              : sourceKind === "folder"
                ? gt("Agent folder")
                : gt("SimplyCode file")
        }
        actions={[
          {
            id: "openbot",
            title: gt("OpenBot (this computer)"),
            state: sourceKind === "openbot" ? "on" : undefined,
          },
          {
            id: "openmausbot",
            title: gt("OpenMausBot (this computer)"),
            state: sourceKind === "openmausbot" ? "on" : undefined,
          },
          {
            id: "folder",
            title: gt("Agent folder"),
            state: sourceKind === "folder" ? "on" : undefined,
          },
          {
            id: "package",
            title: gt("SimplyCode file"),
            state: sourceKind === "package" ? "on" : undefined,
          },
        ]}
        onSelect={(id) => {
          if (id === "openbot" || id === "openmausbot" || id === "folder" || id === "package") {
            pickSourceKind(id);
          }
        }}
      />
      {sourceKind === "folder" ? (
        <>
          <RNTextInput
            value={folderPath}
            onChangeText={setFolderPath}
            placeholder={gt("Path on the server")}
            placeholderTextColor="#888"
            className="rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground"
          />
          <Button label={gt("Scan")} onPress={scan} disabled={folderPath.trim() === "" || busy} />
        </>
      ) : null}
      {sourceKind === "package" ? (
        <Button
          label={packageName === null ? gt("Choose a *.simplycode-bots.json file") : packageName}
          tone="secondary"
          onPress={() => void pickPackage()}
        />
      ) : null}
      {busy && result === null && sourceKind !== "folder" ? (
        <Text className="text-sm text-foreground-muted">{gt("Scanning…")}</Text>
      ) : null}

      {result !== null ? (
        candidates.length === 0 ? (
          <Text className="py-2 text-base text-foreground-muted">
            <T>No bots found.</T>
          </Text>
        ) : (
          <View className="gap-1">
            <Text className="text-sm text-foreground-muted">
              {gt("Found in {source}", { source: result.sourceLabel })}
            </Text>
            {candidates.map((candidate) => (
              <ImportCandidateRow
                key={candidate.key}
                candidate={candidate}
                checked={checked.has(candidate.key)}
                fallbackLabel={fallbackLabel}
                selectionLabel={selectionLabel}
                onToggle={() =>
                  setChecked((current) => {
                    const updated = new Set(current);
                    if (updated.has(candidate.key)) updated.delete(candidate.key);
                    else updated.add(candidate.key);
                    return updated;
                  })
                }
              />
            ))}
            {(
              [
                ["memory", gt("Memory")],
                ["skills", gt("Skills")],
                ["automations", gt("Automations (imported disabled)")],
              ] as const
            ).map(([key, label]) => (
              <View key={key} className="min-h-11 flex-row items-center gap-3 py-1">
                <Text textRole="body" className="flex-1 text-foreground">
                  {label}
                </Text>
                <ThemedSwitch
                  value={include[key]}
                  onValueChange={(next) => setInclude((current) => ({ ...current, [key]: next }))}
                />
              </View>
            ))}
            <SelectRow
              label={gt("Project")}
              value={projects.find((project) => project.id === selectedProjectId)?.title ?? ""}
              actions={projects.map((project) => ({
                id: project.id,
                title: project.title,
                state: project.id === selectedProjectId ? "on" : undefined,
              }))}
              onSelect={(id) => setProjectId(id as ProjectId)}
            />
            <SelectRow
              label={gt("Fallback model")}
              value={fallbackLabel}
              actions={modelOptions.map((option) => ({
                id: option.key,
                title: option.label,
                state: option.key === fallbackKey ? "on" : undefined,
              }))}
              onSelect={setFallbackKey}
            />
            <Button
              label={
                checked.size === 1
                  ? gt("Import {count} bot", { count: checked.size })
                  : gt("Import {count} bots", { count: checked.size })
              }
              onPress={() => void apply()}
              disabled={
                busy || checked.size === 0 || fallback === undefined || selectedProjectId === null
              }
            />
          </View>
        )
      ) : null}
    </View>
  );
}

function ImportCandidateRow(props: {
  readonly candidate: BotImportCandidate;
  readonly checked: boolean;
  readonly fallbackLabel: string;
  readonly selectionLabel: (selection: { instanceId: string; model: string }) => string;
  readonly onToggle: () => void;
}) {
  const gt = useGT();
  const { candidate, checked, fallbackLabel, selectionLabel, onToggle } = props;
  const modelLine =
    candidate.modelSelection !== undefined
      ? selectionLabel(candidate.modelSelection)
      : gt("{model}, not available here, will use {fallback}", {
          model: candidate.sourceModel ?? gt("Unknown model"),
          fallback: fallbackLabel,
        });
  const automationCount = candidate.automations.filter(
    (automation) => automation.importable,
  ).length;
  return (
    <View className="flex-row items-start gap-2 py-2">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text textRole="body" className="text-foreground" numberOfLines={1}>
          {candidate.name}
          {candidate.role !== undefined ? ` · ${candidate.role}` : ""}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {modelLine}
        </Text>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {[
            gt("{count} skills", { count: candidate.skills.length }),
            gt("instructions {size}", { size: formatBytes(candidate.soulBytes) }),
            gt("{count} bytes", { count: candidate.memoryBytes }),
            gt("{count} automations", { count: automationCount }),
            candidate.approvalMode,
          ].join(" · ")}
        </Text>
        {candidate.warnings.map((warning) => (
          <Text key={warning} className="text-sm text-danger-foreground" numberOfLines={2}>
            {warning}
          </Text>
        ))}
      </View>
      <ThemedSwitch value={checked} onValueChange={() => onToggle()} />
    </View>
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
  readonly avatar: BotAvatar;
  readonly role: string;
  readonly description: string;
  readonly pinned: boolean;
  readonly projectId: Bot["projectId"] | null;
  readonly workspace: "root" | "worktree" | "existing_worktree";
  readonly checkoutPath: string;
  readonly modelSelection: ModelSelection | null;
  readonly approvalMode: BotApprovalMode;
  readonly soul: string | null;
  readonly memory: string | null;
  readonly maxSteps: string;
  readonly maxCost: string;
};

function draftForNewBot(
  projectId: Bot["projectId"] | null,
  model: ModelSelection | null,
): BotDraft {
  return {
    name: "",
    avatar: { shape: "rectangle", color: BOT_AVATAR_COLORS[0] },
    role: "",
    description: "",
    pinned: false,
    projectId,
    workspace: "worktree",
    checkoutPath: "",
    modelSelection: model,
    approvalMode: "ask",
    soul: "",
    memory: "",
    maxSteps: "",
    maxCost: "",
  };
}

function draftForBot(bot: Bot, soul: string, memory: string): BotDraft {
  return {
    name: bot.name,
    avatar: botAvatarOrDefault(bot),
    role: bot.role ?? "",
    description: bot.description ?? "",
    pinned: bot.pinned,
    projectId: bot.projectId,
    workspace: bot.workspaceStrategy.type,
    checkoutPath:
      bot.workspaceStrategy.type === "existing_worktree" ? bot.workspaceStrategy.worktreePath : "",
    modelSelection: bot.modelSelection,
    approvalMode: bot.approvalMode,
    soul,
    memory,
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
  const installBotSkill = useAtomCommand(serverEnvironment.installBotSkill, {
    label: "bot install skill",
    reportFailure: false,
  });
  const removeBotSkill = useAtomCommand(serverEnvironment.removeBotSkill, {
    label: "bot remove skill",
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
        ? draftForBot(existing.data.bot, existing.data.soul, existing.data.memory)
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
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? [];
  const botsList = useEnvironmentQuery(serverEnvironment.botsLive({ environmentId, input: {} }));
  const liveBot = botsList.data?.bots.find((bot) => bot.id === botId);
  const botProvider = providers.find(
    (provider) => provider.instanceId === form?.modelSelection?.instanceId,
  );
  const installedSkillNames = new Set<string>((liveBot?.skills ?? []).map((skill) => skill.name));
  const installableSkills =
    botProvider === undefined
      ? []
      : dedupeProviderSkillsByName(
          resolveProviderSkillsForCwd(botProvider, project?.workspaceRoot ?? null).filter(
            isProviderSkillUserInvocable,
          ),
        ).filter((skill) => !installedSkillNames.has(skill.name));
  const [skillBusy, setSkillBusy] = useState(false);
  const soulBytes = new TextEncoder().encode(form?.soul ?? "").length;
  const memoryBytes = new TextEncoder().encode(form?.memory ?? "").length;
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
    const memory = form.memory ?? "";
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
    if (memoryBytes > BOT_MEMORY_MAX_BYTES) {
      Dialog.alert(
        gt("Memory too long"),
        gt("Keep it under {max} bytes.", { max: BOT_MEMORY_MAX_BYTES }),
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
      avatar: form.avatar,
      role: form.role.trim(),
      ...(form.description.trim() ? { description: form.description.trim() } : {}),
      enabled: existing.data?.bot.enabled ?? true,
      pinned: form.pinned,
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
      ...(botId === null || memory !== existing.data?.memory ? { memory } : {}),
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

  const installSkill = (index: number) => {
    const skill = installableSkills[index];
    if (skill === undefined || botId === null || skillBusy) return;
    setSkillBusy(true);
    void installBotSkill({
      environmentId,
      input: { id: botId, sourcePath: skill.path },
    }).then((result) => {
      setSkillBusy(false);
      const message = failureMessage(result);
      if (message !== null) Dialog.alert(gt("Could not install skill"), message);
    });
  };

  const removeSkill = (name: BotSkillName) => {
    if (botId === null || skillBusy) return;
    setSkillBusy(true);
    void removeBotSkill({ environmentId, input: { id: botId, name } }).then((result) => {
      setSkillBusy(false);
      const message = failureMessage(result);
      if (message !== null) Dialog.alert(gt("Could not remove skill"), message);
    });
  };

  const clearMemory = () => {
    Dialog.confirm({
      title: gt("Clear memory?"),
      message: gt("This bot's MEMORY.md will be cleared when you save."),
      confirmText: gt("Clear"),
      destructive: true,
      onConfirm: () => set({ memory: "" }),
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
                label={gt("Role")}
                value={form.role}
                placeholder={gt("Reviewer")}
                disabled={!canOperate || saving}
                maxLength={60}
                borderTop
                onChange={(role) => set({ role })}
              />
              <View className="gap-2 border-t border-border-subtle px-4 py-3">
                <Text textRole="footnote" className="text-foreground-muted">
                  {gt("Avatar")}
                </Text>
                <View className="flex-row items-center gap-3">
                  <BotAvatarView
                    bot={{
                      id: botId ?? "new-bot",
                      name: form.name.trim() || "bot",
                      avatar: form.avatar,
                      enabled: existing.data?.bot.enabled ?? true,
                    }}
                    size={44}
                  />
                  <View className="flex-1 flex-row flex-wrap gap-2">
                    {BOT_AVATAR_COLORS.map((color) => (
                      <Pressable
                        key={color}
                        accessibilityRole="button"
                        accessibilityLabel={color}
                        disabled={!canOperate || saving}
                        onPress={() => set({ avatar: { ...form.avatar, color } })}
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 12,
                          backgroundColor: color,
                          borderWidth: 2,
                          borderColor: form.avatar.color === color ? "#ffffff" : "transparent",
                        }}
                      />
                    ))}
                  </View>
                </View>
              </View>
              <SelectRow
                label={gt("Shape")}
                borderTop
                value={m(AVATAR_SHAPE_LABELS[form.avatar.shape])}
                disabled={!canOperate || saving}
                actions={BOT_AVATAR_SHAPES.map((shape) => ({
                  id: shape,
                  title: m(AVATAR_SHAPE_LABELS[shape]),
                  state: shape === form.avatar.shape ? "on" : undefined,
                }))}
                onSelect={(id) => {
                  if ((BOT_AVATAR_SHAPES as ReadonlyArray<string>).includes(id)) {
                    set({ avatar: { ...form.avatar, shape: id as BotAvatarShape } });
                  }
                }}
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
            <SettingsSection
              title={gt("Memory")}
              footer={
                <Text
                  textRole="footnote"
                  className={
                    memoryBytes > BOT_MEMORY_MAX_BYTES
                      ? "text-danger-foreground"
                      : "text-foreground-muted"
                  }
                >
                  {gt("{bytes} of {max} bytes", {
                    bytes: memoryBytes,
                    max: BOT_MEMORY_MAX_BYTES,
                  })}
                </Text>
              }
            >
              <FormField
                label={gt("MEMORY.md")}
                value={form.memory ?? ""}
                placeholder={gt("Facts and lessons this bot keeps between runs.")}
                multiline
                disabled={!canOperate || saving}
                onChange={(memory) => set({ memory })}
              />
              <Pressable
                accessibilityRole="button"
                disabled={!canOperate || saving || (form.memory ?? "").length === 0}
                onPress={clearMemory}
                className="min-h-12 flex-row items-center border-t border-border-subtle px-4 py-3 active:opacity-70"
              >
                <Text textRole="body" className="text-danger-foreground">
                  {gt("Clear memory")}
                </Text>
              </Pressable>
            </SettingsSection>
            {botId !== null ? (
              <SettingsSection title={gt("Skills")}>
                {(liveBot?.skills ?? []).length === 0 ? (
                  <View className="px-4 py-3">
                    <Text textRole="body" className="text-foreground-muted">
                      {gt("No skills installed.")}
                    </Text>
                  </View>
                ) : (
                  (liveBot?.skills ?? []).map((skill, index) => (
                    <View
                      key={skill.name}
                      className={
                        index === 0
                          ? "min-h-14 flex-row items-start gap-3 px-4 py-3"
                          : "min-h-14 flex-row items-start gap-3 border-t border-border-subtle px-4 py-3"
                      }
                    >
                      <View className="min-w-0 flex-1">
                        <Text textRole="body" className="text-foreground" numberOfLines={1}>
                          {skill.name}
                        </Text>
                        {skill.description !== undefined ? (
                          <Text
                            textRole="footnote"
                            className="text-foreground-muted"
                            numberOfLines={2}
                          >
                            {skill.description}
                          </Text>
                        ) : null}
                      </View>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={gt("Remove {name}", { name: skill.name })}
                        disabled={!canOperate || skillBusy}
                        onPress={() => removeSkill(skill.name)}
                      >
                        <Text textRole="body" className="text-danger-foreground">
                          {gt("Remove")}
                        </Text>
                      </Pressable>
                    </View>
                  ))
                )}
                <SelectRow
                  label={gt("Add a skill")}
                  borderTop={(liveBot?.skills ?? []).length > 0}
                  value=""
                  disabled={!canOperate || skillBusy || installableSkills.length === 0}
                  actions={installableSkills.map((skill, index) => ({
                    id: String(index),
                    title:
                      skill.description === undefined
                        ? skill.name
                        : `${skill.name}: ${skill.description}`,
                  }))}
                  onSelect={(id) => installSkill(Number(id))}
                />
              </SettingsSection>
            ) : null}
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
            <SettingsSection>
              <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
                <Text textRole="body" className="min-w-0 flex-1 text-foreground">
                  {gt("Pin to top")}
                </Text>
                <ThemedSwitch
                  accessibilityLabel={gt("Pin to top")}
                  value={form.pinned}
                  disabled={!canOperate || saving}
                  onValueChange={(pinned) => set({ pinned })}
                />
              </View>
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
