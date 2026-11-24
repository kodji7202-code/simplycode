import { type Bot, type EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";

import { DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { BotProfileForm } from "./BotProfileForm";

export function BotEditorDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot | null;
  readonly onClose: () => void;
  readonly onSaved?: (bot: Bot) => void;
}) {
  const { environmentId, bot, onClose, onSaved } = props;
  const gt = useGT();
  const editing = bot !== null;
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
      <BotProfileForm
        environmentId={environmentId}
        bot={bot}
        variant="dialog"
        onCancel={onClose}
        {...(onSaved === undefined ? {} : { onSaved })}
      />
    </>
  );
}
