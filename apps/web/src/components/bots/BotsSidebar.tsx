import { useAtomValue } from "@effect/atom-react";
import { botAvatarOrDefault, type Bot, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { PlusIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentThreadShells } from "../../state/threads";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Dialog, DialogPopup } from "../ui/dialog";
import { Input } from "../ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/menu";
import { SidebarContent, SidebarGroup } from "../ui/sidebar";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SidebarSectionSwitch } from "../sidebar/SidebarSectionSwitch";
import { BotAvatar } from "./BotAvatar";
import { BotImportDialog, exportBotsToFile } from "./BotImportDialog";
import { botActivity, filterBots, sortBotsForSidebar, type BotActivity } from "./botPage.logic";
import { useBotsEnvironment } from "./useBotsEnvironment";

const EMPTY_THREAD_SHELLS_ATOM = Atom.make<ReadonlyArray<OrchestrationV2ThreadShell>>(
  Object.freeze([]),
).pipe(Atom.withLabel("bots-sidebar-thread-shells:empty"));

const botSearch = (env: string | undefined, bot?: string, create?: true) => ({
  ...(env === undefined ? {} : { env }),
  ...(bot === undefined ? {} : { bot }),
  ...(create === true ? { create: true as const } : {}),
});

function PinnedBotAvatar({ bot, activity }: { bot: Bot; activity: BotActivity }) {
  return (
    <div className="flex w-14 shrink-0 flex-col items-center gap-1">
      <BotAvatar
        bot={bot}
        size={44}
        {...(activity.running ? { state: "working" as const, animated: true } : {})}
      />
      <span className="w-full truncate text-center text-3xs leading-tight text-muted-foreground">
        {bot.name}
      </span>
    </div>
  );
}

export function BotsSidebar() {
  const search = useSearch({ from: "/_chat/bots" });
  const navigate = useNavigate();
  const gt = useGT();
  const messages = useMessages();
  const { environmentId } = useBotsEnvironment(search.env);
  const [query, setQuery] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const exportBots = useAtomCommand(serverEnvironment.exportBots, { label: "bot export" });

  const reportFailure = (title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description:
          error instanceof Error
            ? (thrownErrorMessage(error, messages) ?? error.message)
            : String(error),
      }),
    );
  };

  const exportAll = () => {
    const first = bots[0];
    if (environmentId === null || first === undefined) return;
    void exportBotsToFile(
      (input) => exportBots({ environmentId, input }),
      [first.id, ...bots.slice(1).map((bot) => bot.id)],
      (error) => reportFailure(gt("Export failed"), error),
    );
  };

  const botsQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.botsLive({ environmentId, input: {} }),
    messages,
  );
  const shells = useAtomValue(
    environmentId === null
      ? EMPTY_THREAD_SHELLS_ATOM
      : environmentThreadShells.environmentThreadsAtom(environmentId),
  );

  const bots = botsQuery.data?.bots ?? [];
  const activityById = new Map(bots.map((bot) => [bot.id, botActivity(bot, shells)]));
  const sorted = sortBotsForSidebar(bots, (bot) => activityById.get(bot.id) ?? EMPTY_ACTIVITY);
  const filtered = filterBots(sorted, query);
  const pinned = sorted.filter((bot) => bot.pinned);

  return (
    <SidebarContent
      fixedHeader={
        <SidebarGroup>
          <div className="flex flex-col gap-2">
            <SidebarSectionSwitch />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={gt("Search bots")}
              aria-label={gt("Search bots")}
            />
          </div>
        </SidebarGroup>
      }
    >
      {pinned.length > 0 ? (
        <div className="flex gap-1 overflow-x-auto px-3 pb-2 pt-1">
          {pinned.map((bot) => (
            <button
              key={bot.id}
              type="button"
              onClick={() =>
                void navigate({
                  to: "/bots",
                  search: botSearch(search.env, bot.id),
                })
              }
              className="rounded-md p-1 hover:bg-accent/60 hover:ring-1 hover:ring-inset hover:ring-brand/40 focus-visible:outline-2 focus-visible:outline-brand"
            >
              <PinnedBotAvatar bot={bot} activity={activityById.get(bot.id) ?? EMPTY_ACTIVITY} />
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex items-center justify-between px-3 pb-1 pt-2">
        <span className="flex items-center gap-1.5 text-2xs font-semibold text-muted-foreground">
          <T>All bots</T>
          <span className="rounded-full bg-muted px-1.5 py-px text-3xs tabular-nums">
            {filtered.length}
          </span>
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={gt("Bot menu")}
                disabled={environmentId === null}
              />
            }
          >
            <PlusIcon className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              onClick={() =>
                void navigate({ to: "/bots", search: botSearch(search.env, undefined, true) })
              }
            >
              <T>New bot</T>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setImportOpen(true)}>
              <T>Import bots</T>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={exportAll} disabled={bots.length === 0}>
              <T>Export all bots</T>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogPopup className="sm:max-w-lg">
          {importOpen && environmentId !== null ? (
            <BotImportDialog
              environmentId={environmentId}
              onClose={() => setImportOpen(false)}
              onImported={(imported) => {
                setImportOpen(false);
                const first = imported[0];
                if (first !== undefined) {
                  void navigate({ to: "/bots", search: botSearch(search.env, first.id) });
                }
              }}
            />
          ) : null}
        </DialogPopup>
      </Dialog>
      <ul className="flex flex-col gap-px px-2 pb-2">
        {filtered.map((bot) => {
          const activity = activityById.get(bot.id) ?? EMPTY_ACTIVITY;
          const selected = search.bot === bot.id;
          const color = botAvatarOrDefault(bot).color;
          return (
            <li key={bot.id}>
              <button
                type="button"
                onClick={() =>
                  void navigate({ to: "/bots", search: botSearch(search.env, bot.id) })
                }
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left",
                  selected ? "bg-brand/10 ring-1 ring-inset ring-brand/40" : "hover:bg-accent/60",
                )}
              >
                <BotAvatar
                  bot={bot}
                  size={32}
                  {...(activity.running ? { state: "working" as const, animated: true } : {})}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-xs font-medium">{bot.name}</span>
                    {activity.lastAt !== null ? (
                      <span className="shrink-0 text-3xs text-muted-foreground">
                        {formatRelativeTimeLabel(new Date(activity.lastAt).toISOString())}
                      </span>
                    ) : null}
                  </span>
                  <span className="block truncate text-3xs text-muted-foreground">
                    {bot.role ? (
                      <span className="font-semibold" style={{ color }}>
                        {bot.role}
                      </span>
                    ) : null}
                    {bot.role && activity.lastTitle ? " · " : ""}
                    {activity.lastTitle ?? ""}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
        {filtered.length === 0 ? (
          <li className="px-2 py-3 text-center text-2xs text-muted-foreground">
            {query.trim() === "" ? <T>No bots yet</T> : <T>No bots match</T>}
          </li>
        ) : null}
      </ul>
      <div className="mt-auto border-t border-border/50 px-2 py-2">
        <button
          type="button"
          onClick={() =>
            void navigate({
              to: "/bots",
              search: { ...(search.env === undefined ? {} : { env: search.env }), teams: true },
            })
          }
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs font-medium",
            search.teams === true
              ? "bg-brand/10 ring-1 ring-inset ring-brand/40"
              : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          )}
        >
          <UsersIcon className="size-3.5" aria-hidden />
          <T>Teams and pipelines</T>
        </button>
      </div>
    </SidebarContent>
  );
}

const EMPTY_ACTIVITY: BotActivity = { lastAt: null, lastTitle: null, running: false };
