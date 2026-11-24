import { useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
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
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { createModelSelection } from "@t3tools/shared/model";
import { T, useGT, useMessages } from "gt-react";
import { type ReactNode, useRef, useState } from "react";

import { cn } from "../../lib/utils";

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
import { TraitsPicker } from "../chat/TraitsPicker";
import { Button } from "../ui/button";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { usePaginatedBranches } from "../../state/queries";
import {
  APPROVAL_MODE_RUNTIME_LABELS,
  APPROVAL_MODE_TITLES,
  BOT_APPROVAL_MODES,
  botToDraft,
  draftToBotUpsertInput,
  EMPTY_BOT_DRAFT,
  soulByteLength,
  WORKSPACE_MODES,
  type BotDraft,
} from "./botPage.logic";

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

export function BotEditorDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot | null;
  readonly onClose: () => void;
}) {
  const { environmentId, bot, onClose } = props;
  const gt = useGT();
  const messages = useMessages();
  const editing = bot !== null;
  const detail = useEnvironmentQuery(
    editing ? serverEnvironment.bot({ environmentId, input: { id: bot.id } }) : null,
    messages,
  );
  const [draft, setDraft] = useState<BotDraft>(() =>
    bot === null ? EMPTY_BOT_DRAFT : botToDraft(bot, ""),
  );
  // The soul only exists in bots.get; fill the draft once it arrives.
  const [soulSeeded, setSoulSeeded] = useState(false);
  if (editing && !soulSeeded && detail.data !== null) {
    setSoulSeeded(true);
    setDraft((current) => ({ ...current, soul: detail.data.soul }));
  }
  const [saving, setSaving] = useState(false);
  const submissionPending = useRef(false);

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

  const soulBytes = soulByteLength(draft.soul);
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
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      submissionPending.current ||
      saving
    )
      return;
    if (soulBytes > BOT_SOUL_MAX_BYTES) {
      reportFailure(
        gt("Soul is too long"),
        gt("Keep it under {max} bytes.", { max: BOT_SOUL_MAX_BYTES }),
      );
      return;
    }
    const input = draftToBotUpsertInput(
      { ...draft, projectId: selectedProjectId },
      worktreeBaseRef,
    );
    if (input === null || !projects.some((project) => project.id === selectedProjectId)) {
      reportFailure(gt("Bot is incomplete"), gt("Add a name, project, and model."));
      return;
    }
    submissionPending.current = true;
    setSaving(true);
    const result = await upsertBot({ environmentId, input });
    setSaving(false);
    if (result._tag === "Failure") {
      submissionPending.current = false;
      if (!isAtomCommandInterrupted(result)) {
        reportFailure(gt("Could not save bot"), squashAtomCommandFailure(result));
      }
      return;
    }
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editing ? gt("Edit bot") : gt("New bot")}</DialogTitle>
        <DialogDescription>
          <T>
            A bot is a saved profile that runs as ordinary threads: its own project, model,
            permissions, and standing instructions.
          </T>
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <fieldset disabled={saving} className="min-w-0 space-y-5">
          <div className="flex gap-3">
            <Field label={gt("Avatar")} htmlFor="bot-avatar" className="w-20 shrink-0">
              <Input
                id="bot-avatar"
                value={draft.avatar}
                maxLength={8}
                placeholder={(draft.name.trim()[0] ?? "B").toUpperCase()}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, avatar: event.target.value }))
                }
              />
            </Field>
            <Field label={gt("Name")} htmlFor="bot-name" className="min-w-0 flex-1">
              <Input
                id="bot-name"
                value={draft.name}
                maxLength={100}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, name: event.target.value }))
                }
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

          <Field label={gt("Project")} htmlFor="bot-project">
            <Select
              value={selectedProjectId}
              onValueChange={(value) =>
                setDraft((current) => ({ ...current, projectId: value as string }))
              }
            >
              <SelectTrigger id="bot-project" className="w-full">
                <SelectValue />
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
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {WORKSPACE_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {mode === "root" ? gt("Project folder") : gt("New worktree")}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </Field>

          <Field label={gt("Model")}>
            <div className="flex flex-wrap items-center gap-1.5">
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
              {activeSelection !== null && activeEntry ? (
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
              ) : null}
            </div>
          </Field>

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
                <SelectValue />
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

          <Field label={gt("Standing instructions (SOUL.md)")} htmlFor="bot-soul">
            <Textarea
              id="bot-soul"
              className="max-h-64 overflow-y-auto"
              placeholder={gt("How should this bot behave every time it runs?")}
              value={draft.soul}
              onChange={(event) =>
                setDraft((current) => ({ ...current, soul: event.target.value }))
              }
            />
            <p className="mt-1 text-2xs text-muted-foreground">
              {gt("{used} / {max} bytes", { used: soulBytes, max: BOT_SOUL_MAX_BYTES })}
            </p>
          </Field>

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
      </DialogPanel>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>
          <T>Cancel</T>
        </Button>
        <Button onClick={() => void submit()} disabled={saving || !canOperate}>
          {editing ? gt("Save") : gt("Create bot")}
        </Button>
      </DialogFooter>
    </>
  );
}
