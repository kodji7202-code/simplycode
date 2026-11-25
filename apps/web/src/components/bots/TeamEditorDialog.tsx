import { type Bot, type EnvironmentId, type Team } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
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
import { Checkbox } from "../ui/checkbox";
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  draftToTeamUpsertInput,
  teamToDraft,
  emptyTeamDraft,
  type TeamDraft,
} from "./teamsPipelines.logic";

const NO_LEAD = "__none__";

export function TeamEditorDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly team: Team | null;
  readonly bots: ReadonlyArray<Bot>;
  readonly onClose: () => void;
  readonly onSaved?: (team: Team) => void;
}) {
  const { environmentId, team, bots, onClose, onSaved } = props;
  const gt = useGT();
  const [draft, setDraft] = useState<TeamDraft>(() =>
    team === null ? emptyTeamDraft() : teamToDraft(team),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const upsert = useAtomCommand(serverEnvironment.upsertTeam, { label: "team upsert" });

  const patch = (next: Partial<TeamDraft>) => setDraft((current) => ({ ...current, ...next }));
  const toggleMember = (botId: string, checked: boolean) =>
    patch({
      memberBotIds: checked
        ? [...draft.memberBotIds, botId]
        : draft.memberBotIds.filter((id) => id !== botId),
    });

  const save = async () => {
    const input = draftToTeamUpsertInput(draft);
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
    onSaved?.(result.value.team);
    onClose();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{team === null ? gt("New team") : gt("Edit team")}</DialogTitle>
        <DialogDescription>
          <T>A team is a group of bots one of them leads. Pipelines run its members in order.</T>
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-3 px-1 py-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="team-name">
            <T>Name</T>
          </Label>
          <Input
            id="team-name"
            value={draft.name}
            placeholder={gt("Build")}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="team-description">
            <T>Description</T>
          </Label>
          <Input
            id="team-description"
            value={draft.description}
            placeholder={gt("What this team is for")}
            onChange={(event) => patch({ description: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="team-lead">
            <T>Lead</T>
          </Label>
          <Select
            value={draft.leadBotId === "" ? NO_LEAD : draft.leadBotId}
            onValueChange={(value) =>
              patch({ leadBotId: value === null || value === NO_LEAD ? "" : value })
            }
          >
            <SelectTrigger id="team-lead" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value={NO_LEAD} label={gt("No lead")}>
                {gt("No lead")}
              </SelectItem>
              {bots.map((bot) => (
                <SelectItem key={bot.id} value={bot.id} label={bot.name}>
                  {bot.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <p className="text-2xs text-muted-foreground">
            <T>
              The lead's instructions list the team and tell it to delegate with delegate_to_bot.
            </T>
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>
            <T>Members</T>
          </Label>
          <ul className="max-h-48 overflow-y-auto rounded-lg border border-border/60">
            {bots.map((bot) => {
              const checked = draft.memberBotIds.includes(bot.id);
              return (
                <li key={bot.id}>
                  <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-accent/60">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(next) => toggleMember(bot.id, next === true)}
                      aria-label={bot.name}
                    />
                    <span className="truncate">{bot.name}</span>
                    {bot.role ? (
                      <span className="truncate text-2xs text-muted-foreground">{bot.role}</span>
                    ) : null}
                  </label>
                </li>
              );
            })}
            {bots.length === 0 ? (
              <li className="px-2.5 py-3 text-center text-2xs text-muted-foreground">
                <T>No bots yet. Create bots first.</T>
              </li>
            ) : null}
          </ul>
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
        <Button onClick={() => void save()} disabled={busy || draft.name.trim() === ""}>
          {team === null ? <T>Create team</T> : <T>Save</T>}
        </Button>
      </DialogFooter>
    </>
  );
}
