import { type Bot, type EnvironmentId, type Pipeline, type Team } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "../../i18n/messages";
import { useAtomCommand } from "../../state/use-atom-command";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  draftToPipelineUpsertInput,
  newPipelineDraft,
  newStageDraft,
  PIPELINE_BOUNDS,
  pipelineToDraft,
  type PipelineDraft,
  type StageDraft,
} from "./teamsPipelines.logic";

function moveStage(stages: ReadonlyArray<StageDraft>, index: number, delta: -1 | 1) {
  const target = index + delta;
  if (target < 0 || target >= stages.length) return stages;
  const next = [...stages];
  const [stage] = next.splice(index, 1);
  next.splice(target, 0, stage!);
  return next;
}

function StageEditor(props: {
  readonly stage: StageDraft;
  readonly index: number;
  readonly total: number;
  readonly members: ReadonlyArray<Bot>;
  readonly workStagesBefore: ReadonlyArray<StageDraft>;
  readonly onChange: (index: number, patch: Partial<StageDraft>) => void;
  readonly onMove: (index: number, delta: -1 | 1) => void;
  readonly onRemove: (index: number) => void;
}) {
  const { stage, index, total, members, workStagesBefore, onChange, onMove, onRemove } = props;
  const gt = useGT();
  return (
    <li className="rounded-lg border border-border/60 p-2.5">
      <div className="flex items-center gap-1.5">
        <span className="w-5 shrink-0 text-center text-2xs font-semibold text-muted-foreground">
          {index + 1}
        </span>
        <Input
          value={stage.name}
          placeholder={gt("Stage name")}
          aria-label={gt("Stage {index} name", { index: index + 1 })}
          className="min-w-0 flex-1"
          onChange={(event) => onChange(index, { name: event.target.value })}
        />
        <Select
          value={stage.kind}
          onValueChange={(value) => {
            if (value === null) return;
            onChange(index, {
              kind: value as StageDraft["kind"],
              ...(value === "work" ? { onFail: "" } : {}),
            });
          }}
        >
          <SelectTrigger
            className="w-24"
            aria-label={gt("Stage {index} kind", { index: index + 1 })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="work" label={gt("Work")}>
              {gt("Work")}
            </SelectItem>
            <SelectItem value="review" label={gt("Review")}>
              {gt("Review")}
            </SelectItem>
          </SelectPopup>
        </Select>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={gt("Move stage up")}
          disabled={index === 0}
          onClick={() => onMove(index, -1)}
        >
          <ArrowUpIcon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={gt("Move stage down")}
          disabled={index === total - 1}
          onClick={() => onMove(index, 1)}
        >
          <ArrowDownIcon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={gt("Remove stage")}
          disabled={total === 1}
          onClick={() => onRemove(index)}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <Select
          value={stage.botId}
          onValueChange={(value) => onChange(index, { botId: value ?? "" })}
        >
          <SelectTrigger
            className="min-w-0 flex-1"
            aria-label={gt("Stage {index} bot", { index: index + 1 })}
          >
            <SelectValue placeholder={gt("Pick a team member")} />
          </SelectTrigger>
          <SelectPopup>
            {members.map((bot) => (
              <SelectItem key={bot.id} value={bot.id} label={bot.name}>
                {bot.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {stage.kind === "review" ? (
          <Select
            value={stage.onFail}
            onValueChange={(value) => onChange(index, { onFail: value ?? "" })}
          >
            <SelectTrigger
              className="min-w-0 flex-1"
              aria-label={gt("Stage {index} on failure", { index: index + 1 })}
            >
              <SelectValue placeholder={gt("If it fails, go back to")} />
            </SelectTrigger>
            <SelectPopup>
              {workStagesBefore.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id} label={candidate.name}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : null}
      </div>
      <Textarea
        value={stage.instructions}
        placeholder={gt("What this stage does")}
        aria-label={gt("Stage {index} instructions", { index: index + 1 })}
        className="mt-2 max-h-32 min-h-14"
        onChange={(event) => onChange(index, { instructions: event.target.value })}
      />
    </li>
  );
}

export function PipelineEditorDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly team: Team;
  readonly pipeline: Pipeline | null;
  readonly members: ReadonlyArray<Bot>;
  readonly onClose: () => void;
  readonly onSaved?: (pipeline: Pipeline) => void;
}) {
  const { environmentId, team, pipeline, members, onClose, onSaved } = props;
  const gt = useGT();
  const [draft, setDraft] = useState<PipelineDraft>(() =>
    pipeline === null ? newPipelineDraft(team.id) : pipelineToDraft(pipeline),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const upsert = useAtomCommand(serverEnvironment.upsertPipeline, { label: "pipeline upsert" });

  const patch = (next: Partial<PipelineDraft>) => setDraft((current) => ({ ...current, ...next }));
  const changeStage = (index: number, next: Partial<StageDraft>) =>
    patch({
      stages: draft.stages.map((stage, at) => (at === index ? { ...stage, ...next } : stage)),
    });
  const addStage = () =>
    patch({
      stages: [...draft.stages, newStageDraft(new Set(draft.stages.map((stage) => stage.id)))],
    });

  const save = async () => {
    const input = draftToPipelineUpsertInput(draft);
    if (input === null || busy) return;
    setBusy(true);
    const result = await upsert({ environmentId, input });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error
            ? (thrownErrorMessage(failure, m) ?? failure.message)
            : String(failure),
        );
      }
      return;
    }
    onSaved?.(result.value.pipeline);
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{pipeline === null ? gt("New pipeline") : gt("Edit pipeline")}</DialogTitle>
        <DialogDescription>
          <T>
            A pipeline runs its stages in order as one workflow run. A failed review goes back to an
            earlier stage, up to the round limit.
          </T>
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3 px-1 py-3">
        <div className="flex gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="pipeline-name">
              <T>Name</T>
            </Label>
            <Input
              id="pipeline-name"
              value={draft.name}
              placeholder={gt("Ship")}
              onChange={(event) => patch({ name: event.target.value })}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Label htmlFor="pipeline-description">
              <T>Description</T>
            </Label>
            <Input
              id="pipeline-description"
              value={draft.description}
              placeholder={gt("What this pipeline produces")}
              onChange={(event) => patch({ description: event.target.value })}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>
            <T>Stages</T>
          </Label>
          <ul className="flex flex-col gap-2">
            {draft.stages.map((stage, index) => (
              <StageEditor
                key={stage.id}
                stage={stage}
                index={index}
                total={draft.stages.length}
                members={members}
                workStagesBefore={draft.stages
                  .slice(0, index)
                  .filter((candidate) => candidate.kind === "work")}
                onChange={changeStage}
                onMove={(at, delta) => patch({ stages: moveStage(draft.stages, at, delta) })}
                onRemove={(at) => patch({ stages: draft.stages.filter((_, kept) => kept !== at) })}
              />
            ))}
          </ul>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={draft.stages.length >= PIPELINE_BOUNDS.stages}
            onClick={addStage}
          >
            <PlusIcon className="size-3.5" />
            <T>Add stage</T>
          </Button>
        </div>
        <div className="flex gap-2">
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="pipeline-max-rounds">
              <T>Max rounds</T>
            </Label>
            <Input
              id="pipeline-max-rounds"
              type="number"
              min={PIPELINE_BOUNDS.maxRounds.min}
              max={PIPELINE_BOUNDS.maxRounds.max}
              value={draft.maxRounds}
              onChange={(event) => patch({ maxRounds: event.target.value })}
            />
            <p className="text-2xs text-muted-foreground">
              {gt(
                "How many times a review may send work back before the run asks you, between {min} and {max}.",
                {
                  min: PIPELINE_BOUNDS.maxRounds.min,
                  max: PIPELINE_BOUNDS.maxRounds.max,
                },
              )}
            </p>
          </div>
          <div className="flex flex-1 flex-col gap-1.5">
            <Label htmlFor="pipeline-stage-timeout">
              <T>Stage timeout (minutes)</T>
            </Label>
            <Input
              id="pipeline-stage-timeout"
              type="number"
              min={PIPELINE_BOUNDS.stageTimeoutMinutes.min}
              max={PIPELINE_BOUNDS.stageTimeoutMinutes.max}
              value={draft.stageTimeoutMinutes}
              onChange={(event) => patch({ stageTimeoutMinutes: event.target.value })}
            />
            <p className="text-2xs text-muted-foreground">
              {gt("One stage's longest run, between {min} and {max} minutes.", {
                min: PIPELINE_BOUNDS.stageTimeoutMinutes.min,
                max: PIPELINE_BOUNDS.stageTimeoutMinutes.max,
              })}
            </p>
          </div>
        </div>
        {error !== null ? (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-2xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          <T>Cancel</T>
        </Button>
        <Button
          onClick={() => void save()}
          disabled={busy || draftToPipelineUpsertInput(draft) === null}
        >
          {pipeline === null ? <T>Create pipeline</T> : <T>Save</T>}
        </Button>
      </DialogFooter>
    </>
  );
}
