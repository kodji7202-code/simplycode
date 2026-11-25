import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  BOT_AVATAR_COLORS,
  BOT_AVATAR_SHAPES,
  BOT_MEMORY_MAX_BYTES,
  BOT_SOUL_MAX_BYTES,
  type Bot,
  type EnvironmentId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scheduledTaskWorktreeBaseRef } from "@t3tools/client-runtime/scheduled-task-worktree";
import {
  dedupeProviderSkillsByName,
  isProviderSkillUserInvocable,
  resolveProviderSkillsForCwd,
  resolveProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { createModelSelection } from "@t3tools/shared/model";
import { T, useGT, useMessages } from "gt-react";
import { type ReactNode, useRef, useState } from "react";

import { cn } from "../../lib/utils";

import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { m } from "../../i18n/messages";
import { getCustomModelOptionsByInstance, selectsPlanAgent } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { readEnvironmentScope } from "../../state/session";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { getTraitsSectionVisibility, TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import { DialogFooter, DialogPanel } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { usePaginatedBranches } from "../../state/queries";
import {
  APPROVAL_MODE_RUNTIME_LABELS,
  APPROVAL_MODE_TITLES,
  BOT_APPROVAL_MODES,
  BOT_AVATAR_COLOR_LABELS,
  BOT_AVATAR_SHAPE_LABELS,
  BOT_SKILL_SOURCE_LABELS,
  botToDraft,
  draftToBotUpsertInput,
  EMPTY_BOT_DRAFT,
  soulByteLength,
  WORKSPACE_MODE_LABELS,
  WORKSPACE_MODES,
  type BotDraft,
} from "./botPage.logic";
import { BotAvatar } from "./BotAvatar";

function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

/** The bot editor fields and submit flow, shared by the dialog and the profile panel. */
export function BotProfileForm(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot | null;
  readonly variant: "dialog" | "panel";
  readonly onCancel?: () => void;
  readonly onSaved?: (bot: Bot) => void;
}) {
  const { environmentId, bot, variant, onCancel, onSaved } = props;
  const gt = useGT();
  const messages = useMessages();
  const editing = bot !== null;
  const detail = useEnvironmentQuery(
    editing ? serverEnvironment.bot({ environmentId, input: { id: bot.id } }) : null,
    messages,
  );
  const [draft, setDraft] = useState<BotDraft>(() =>
    bot === null ? EMPTY_BOT_DRAFT : botToDraft(bot, "", ""),
  );
  // Baseline for the panel's dirty/Revert state: the draft as loaded or last saved.
  const [baseline, setBaseline] = useState<BotDraft>(draft);
  // The soul and memory only exist in bots.get; fill the draft once it arrives.
  const [soulSeeded, setSoulSeeded] = useState(false);
  if (editing && !soulSeeded && detail.data !== null) {
    const { soul, memory } = detail.data;
    setSoulSeeded(true);
    setDraft((current) => ({ ...current, soul, memory }));
    setBaseline((current) => ({ ...current, soul, memory }));
  }
  const [saving, setSaving] = useState(false);
  const submissionPending = useRef(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);

  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const canOperate = useAtomValue(serverEnvironment.upsertBot.permissionAtom(environmentId));
  const upsertBot = useAtomCommand(serverEnvironment.upsertBot, { label: "bot upsert" });

  const allProjects = useProjects();
  const scopedProjects = allProjects.filter((project) => project.environmentId === environmentId);
  const projects = scopedProjects
    .filter((project) => project.archivedAt == null || project.id === draft.projectId)
    .sort((left, right) => Number(right.pinnedAt != null) - Number(left.pinnedAt != null));
  const selectedProjectId = draft.projectId || projects[0]?.id || "";
  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  const automaticBaseRef = draft.workspaceMode === "worktree";
  const automaticBaseRefs = usePaginatedBranches({
    environmentId,
    cwd: automaticBaseRef ? (selectedProject?.workspaceRoot ?? null) : null,
    query: "",
  });
  const worktreeBaseRef = scheduledTaskWorktreeBaseRef("", automaticBaseRefs.refs);

  const instanceEntries = providerInstanceEntriesFor(
    providers,
    settings,
    selectedProject?.id ?? null,
  );
  const firstInstance = instanceEntries[0];
  const activeSelection =
    draft.modelSelection !== null &&
    instanceEntries.some(
      (entry) => entry.instanceId === draft.modelSelection?.instanceId && entry.enabled,
    )
      ? draft.modelSelection
      : scheduledTaskDefaultModel(settings, selectedProject ?? null, instanceEntries);
  const activeInstanceId =
    activeSelection?.instanceId ?? firstInstance?.instanceId ?? ("" as ProviderInstanceId);
  const activeModel = activeSelection?.model ?? "";
  const activeEntry = instanceEntries.find((entry) => entry.instanceId === activeInstanceId);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    activeInstanceId,
    activeModel,
  );
  const traitsVisibility =
    activeSelection !== null && activeEntry
      ? getTraitsSectionVisibility({
          provider: activeEntry.driverKind,
          models: activeEntry.models,
          model: activeModel,
          modelOptions: activeSelection.options ?? [],
          allowPromptInjectedEffort: false,
          includePlanAgent: selectsPlanAgent(activeSelection.options),
        })
      : null;

  const soulBytes = soulByteLength(draft.soul);
  const memoryBytes = soulByteLength(draft.memory);
  const [skillBusy, setSkillBusy] = useState(false);
  const installBotSkill = useAtomCommand(serverEnvironment.installBotSkill, {
    label: "bot install skill",
  });
  const removeBotSkill = useAtomCommand(serverEnvironment.removeBotSkill, {
    label: "bot remove skill",
  });
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

  const submit = async () => {
    if (submissionPending.current || saving) return;
    if (!canOperate || !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      reportFailure(
        gt("Could not save bot"),
        gt("This session cannot change orchestration settings."),
      );
      return;
    }
    if (soulBytes > BOT_SOUL_MAX_BYTES) {
      reportFailure(
        gt("Soul is too long"),
        gt("Keep it under {max} bytes.", { max: BOT_SOUL_MAX_BYTES }),
      );
      return;
    }
    if (memoryBytes > BOT_MEMORY_MAX_BYTES) {
      reportFailure(
        gt("Memory is too long"),
        gt("Keep it under {max} bytes.", { max: BOT_MEMORY_MAX_BYTES }),
      );
      return;
    }
    const resolvedDraft = {
      // The pickers resolve display defaults (model, project) that only live
      // outside the draft until the user changes them.
      ...draft,
      projectId: selectedProjectId,
      modelSelection: activeSelection,
    };
    const input = draftToBotUpsertInput(resolvedDraft, worktreeBaseRef);
    if (input === null || !projects.some((project) => project.id === selectedProjectId)) {
      reportFailure(gt("Bot is incomplete"), gt("Add a name, project, and model."));
      return;
    }
    submissionPending.current = true;
    setSaving(true);
    const result = await upsertBot({ environmentId, input }).catch((error: unknown) => {
      reportFailure(gt("Could not save bot"), error);
      return null;
    });
    setSaving(false);
    submissionPending.current = false;
    if (result === null) return;
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        reportFailure(gt("Could not save bot"), squashAtomCommandFailure(result));
      }
      return;
    }
    setBaseline(resolvedDraft);
    onSaved?.(result.value.bot);
  };

  const revert = () => setDraft(baseline);

  const installedSkillNames = new Set<string>((bot?.skills ?? []).map((skill) => skill.name));
  const activeProvider = providers.find((provider) => provider.instanceId === activeInstanceId);
  const installableSkills =
    activeProvider === undefined
      ? []
      : dedupeProviderSkillsByName(
          resolveProviderSkillsForCwd(
            activeProvider,
            selectedProject?.workspaceRoot ?? null,
          ).filter(isProviderSkillUserInvocable),
        ).filter((skill) => !installedSkillNames.has(skill.name));

  const installSkill = async (sourcePath: string) => {
    if (bot === null || skillBusy) return;
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      reportFailure(
        gt("Could not install skill"),
        gt("This session cannot change orchestration settings."),
      );
      return;
    }
    setSkillBusy(true);
    const result = await installBotSkill({ environmentId, input: { id: bot.id, sourcePath } });
    setSkillBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not install skill"), squashAtomCommandFailure(result));
    }
  };

  const removeSkill = async (name: Bot["skills"][number]["name"]) => {
    if (bot === null || skillBusy) return;
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
      reportFailure(
        gt("Could not remove skill"),
        gt("This session cannot change orchestration settings."),
      );
      return;
    }
    setSkillBusy(true);
    const result = await removeBotSkill({ environmentId, input: { id: bot.id, name } });
    setSkillBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(gt("Could not remove skill"), squashAtomCommandFailure(result));
    }
  };

  const clearMemory = async () => {
    const message = gt("Clear this bot's memory?");
    const confirmed = (await requestConfirmDialog(message)) ?? window.confirm(message);
    if (confirmed) setDraft((current) => ({ ...current, memory: "" }));
  };

  const fields = (
    <fieldset disabled={saving} className="min-w-0 space-y-5">
      <Field label={gt("Avatar")}>
        <div className="flex items-center gap-4">
          <BotAvatar
            bot={{
              id: draft.editingId ?? "new-bot",
              name: draft.name.trim() || gt("New bot"),
              avatar: draft.avatar,
              enabled: draft.enabled,
            }}
            size={64}
            glow
          />
          <div className="min-w-0 flex-1 space-y-2">
            <div
              className="grid grid-cols-4 rounded-md bg-muted/70 p-0.5 text-2xs font-medium"
              role="group"
              aria-label={gt("Shape")}
            >
              {BOT_AVATAR_SHAPES.map((shape) => (
                <button
                  key={shape}
                  type="button"
                  aria-pressed={draft.avatar.shape === shape}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      avatar: { ...current.avatar, shape },
                    }))
                  }
                  className={cn(
                    "truncate rounded-sm px-1 py-1 transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                    draft.avatar.shape === shape
                      ? "bg-card text-foreground shadow-xs ring-1 ring-inset ring-brand/45"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m(BOT_AVATAR_SHAPE_LABELS[shape])}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={gt("Color")}>
              {BOT_AVATAR_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={m(BOT_AVATAR_COLOR_LABELS[color])}
                  aria-pressed={draft.avatar.color === color}
                  className={cn(
                    "size-5 rounded-full ring-foreground ring-offset-2 ring-offset-background transition-shadow",
                    draft.avatar.color === color ? "ring-2" : "hover:ring-1",
                  )}
                  style={{ backgroundColor: color }}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      avatar: { ...current.avatar, color },
                    }))
                  }
                />
              ))}
            </div>
          </div>
        </div>
      </Field>

      <div className="flex gap-3">
        <Field label={gt("Name")} htmlFor="bot-name" className="min-w-0 flex-1">
          <Input
            id="bot-name"
            value={draft.name}
            maxLength={100}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          />
        </Field>
        <Field label={gt("Role")} htmlFor="bot-role" className="min-w-0 flex-1">
          <Input
            id="bot-role"
            value={draft.role}
            maxLength={60}
            placeholder={gt("Reviewer")}
            onChange={(event) => setDraft((current) => ({ ...current, role: event.target.value }))}
          />
        </Field>
      </div>

      <Field label={gt("Description")} htmlFor="bot-description">
        <Input
          id="bot-description"
          value={draft.description}
          maxLength={1000}
          onChange={(event) =>
            setDraft((current) => ({ ...current, description: event.target.value }))
          }
        />
      </Field>

      <Field label={gt("Model")}>
        <div className="flex">
          <ProviderModelPicker
            environmentId={environmentId}
            disabled={saving}
            activeInstanceId={activeInstanceId}
            model={activeModel}
            lockedProvider={null}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={modelOptionsByInstance}
            isComposerOwned={false}
            triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
            onInstanceModelChange={(instanceId, model) => {
              if (instanceId === activeSelection?.instanceId && model === activeSelection.model)
                return;
              setDraft((current) => ({
                ...current,
                modelSelection: createModelSelection(instanceId, model),
              }));
            }}
          />
        </div>
      </Field>

      {activeSelection !== null && activeEntry && traitsVisibility?.hasAnyControls ? (
        <Field label={gt("Thinking")}>
          <TraitsPicker
            provider={activeEntry.driverKind}
            models={activeEntry.models}
            model={activeModel}
            modelOptions={activeSelection.options ?? []}
            allowPromptInjectedEffort={false}
            includePlanAgent={selectsPlanAgent(activeSelection.options)}
            disabled={saving}
            triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
            onModelOptionsChange={(options) =>
              setDraft((current) => ({
                ...current,
                modelSelection: createModelSelection(activeInstanceId, activeModel, options),
              }))
            }
          />
        </Field>
      ) : null}

      <Field label={gt("Approval mode")} htmlFor="bot-approval">
        <Select
          value={draft.approvalMode}
          onValueChange={(value) =>
            setDraft((current) => ({
              ...current,
              approvalMode: value as BotDraft["approvalMode"],
            }))
          }
        >
          <SelectTrigger id="bot-approval" className="w-full">
            <SelectValue>
              {m(APPROVAL_MODE_TITLES[draft.approvalMode])} ·{" "}
              {m(APPROVAL_MODE_RUNTIME_LABELS[draft.approvalMode])}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {BOT_APPROVAL_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {m(APPROVAL_MODE_TITLES[mode])} · {m(APPROVAL_MODE_RUNTIME_LABELS[mode])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="bot-manage-bots">
            <T>Can create and edit other bots</T>
          </Label>
          <Switch
            id="bot-manage-bots"
            checked={draft.canManageBots}
            onCheckedChange={(canManageBots) =>
              setDraft((current) => ({ ...current, canManageBots }))
            }
          />
        </div>
        <p className="text-xs text-muted-foreground">
          <T>
            Gives this bot tools to create bots and change other bots' instructions, model and
            approval mode, never above its own.
          </T>
        </p>
      </div>

      <Field label={gt("Workspace")} htmlFor="bot-workspace">
        <Select
          value={draft.workspaceMode}
          onValueChange={(value) =>
            setDraft((current) => ({
              ...current,
              workspaceMode: value as BotDraft["workspaceMode"],
            }))
          }
        >
          <SelectTrigger id="bot-workspace" className="w-full">
            <SelectValue>{m(WORKSPACE_MODE_LABELS[draft.workspaceMode])}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {WORKSPACE_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {m(WORKSPACE_MODE_LABELS[mode])}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>

      <Field label={gt("Project")} htmlFor="bot-project">
        <Select
          value={selectedProjectId}
          onValueChange={(value) =>
            setDraft((current) => ({ ...current, projectId: value as string }))
          }
        >
          <SelectTrigger id="bot-project" className="w-full">
            <SelectValue placeholder={gt("Select a project")}>{selectedProject?.title}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id} label={project.title}>
                <span className="block truncate">{project.title}</span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Field>

      <Field label={gt("Standing instructions (SOUL.md)")} htmlFor="bot-soul">
        <Textarea
          id="bot-soul"
          className="max-h-64 overflow-y-auto"
          placeholder={gt("How should this bot behave every time it runs?")}
          value={draft.soul}
          onChange={(event) => setDraft((current) => ({ ...current, soul: event.target.value }))}
        />
        <p className="mt-1 text-2xs text-muted-foreground">
          {gt("{used} / {max} bytes", { used: soulBytes, max: BOT_SOUL_MAX_BYTES })}
        </p>
      </Field>

      <Field label={gt("Memory (MEMORY.md)")} htmlFor="bot-memory">
        <Textarea
          id="bot-memory"
          className="max-h-48 overflow-y-auto"
          placeholder={gt("Facts and lessons this bot keeps between runs.")}
          value={draft.memory}
          onChange={(event) => setDraft((current) => ({ ...current, memory: event.target.value }))}
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <p
            className={cn(
              "text-2xs",
              memoryBytes > BOT_MEMORY_MAX_BYTES ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {gt("{used} / {max} bytes", { used: memoryBytes, max: BOT_MEMORY_MAX_BYTES })}
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={draft.memory.length === 0}
            onClick={() => void clearMemory()}
          >
            <T>Clear</T>
          </Button>
        </div>
      </Field>

      {bot !== null ? (
        <Field label={gt("Skills")}>
          <div className="space-y-2">
            {bot.skills.length === 0 ? (
              <p className="text-2xs text-muted-foreground">
                <T>No skills installed.</T>
              </p>
            ) : (
              <ul className="space-y-1.5">
                {bot.skills.map((skill) => (
                  <li
                    key={skill.name}
                    className="flex items-start justify-between gap-2 rounded-md border border-border/60 px-2.5 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <Tooltip>
                        <TooltipTrigger
                          render={<p className="truncate text-xs font-medium">{skill.name}</p>}
                        />
                        <TooltipPopup>{skill.name}</TooltipPopup>
                      </Tooltip>
                      {skill.description !== undefined ? (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <p className="line-clamp-2 text-2xs text-muted-foreground">
                                {skill.description}
                              </p>
                            }
                          />
                          <TooltipPopup>{skill.description}</TooltipPopup>
                        </Tooltip>
                      ) : null}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={skillBusy}
                      onClick={() => void removeSkill(skill.name)}
                    >
                      <T>Remove</T>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {installableSkills.length > 0 ? (
              <Select
                value=""
                onValueChange={(value) => {
                  if (value !== null) void installSkill(value);
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={gt("Add a skill")} />
                </SelectTrigger>
                <SelectPopup>
                  {installableSkills.map((skill) => (
                    <SelectItem key={skill.path} value={skill.path} label={skill.name}>
                      <span className="block truncate">
                        {skill.name}
                        <span className="text-muted-foreground">
                          {`: ${skill.description ?? gt("no description")} (${
                            skill.scope ??
                            m(BOT_SKILL_SOURCE_LABELS[resolveProviderSkillSourceKind(skill)])
                          })`}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
          </div>
        </Field>
      ) : null}

      <div className="flex gap-3">
        <Field label={gt("Max steps per run")} htmlFor="bot-max-steps" className="flex-1">
          <Input
            id="bot-max-steps"
            inputMode="numeric"
            value={draft.maxStepsPerRun}
            placeholder={gt("No limit")}
            onChange={(event) =>
              setDraft((current) => ({ ...current, maxStepsPerRun: event.target.value }))
            }
          />
        </Field>
        <Field label={gt("Max cost (USD)")} htmlFor="bot-max-cost" className="flex-1">
          <Input
            id="bot-max-cost"
            inputMode="decimal"
            value={draft.maxCostUsd}
            placeholder={gt("No limit")}
            onChange={(event) =>
              setDraft((current) => ({ ...current, maxCostUsd: event.target.value }))
            }
          />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="bot-pinned">
          <T>Pin to top</T>
        </Label>
        <Switch
          id="bot-pinned"
          checked={draft.pinned}
          onCheckedChange={(pinned) => setDraft((current) => ({ ...current, pinned }))}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="bot-enabled">
          <T>Enabled</T>
        </Label>
        <Switch
          id="bot-enabled"
          checked={draft.enabled}
          onCheckedChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
        />
      </div>
    </fieldset>
  );

  return variant === "dialog" ? (
    <>
      <DialogPanel>{fields}</DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          <T>Cancel</T>
        </Button>
        <Button onClick={() => void submit()} disabled={saving || !canOperate}>
          {editing ? gt("Save") : gt("Create bot")}
        </Button>
      </DialogFooter>
    </>
  ) : (
    <>
      {fields}
      {dirty ? (
        <div className="sticky bottom-0 mt-4 flex justify-end gap-2 border-t border-border/50 bg-background py-3">
          <Button variant="outline" size="sm" onClick={revert} disabled={saving}>
            <T>Revert</T>
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={saving || !canOperate}>
            <T>Save</T>
          </Button>
        </div>
      ) : null}
    </>
  );
}
