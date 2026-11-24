import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, botAvatarOrDefault, type Bot } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SidebarContent, SidebarGroup } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SidebarSectionSwitch } from "../sidebar/SidebarSectionSwitch";
import { BotAvatar } from "./BotAvatar";
import { botActivity, filterBots, sortBotsForSidebar, type BotActivity } from "./botPage.logic";
import { useBotsEnvironment } from "./useBotsEnvironment";

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

  const botsQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.botsLive({ environmentId, input: {} }),
    messages,
  );
  const shells = useAtomValue(
    environmentThreadShells.environmentThreadsAtom(environmentId ?? EnvironmentId.make("")),
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
              className="rounded-md p-1 hover:bg-accent/60 focus-visible:outline-2 focus-visible:outline-ring"
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
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={gt("New bot")}
                onClick={() =>
                  void navigate({ to: "/bots", search: botSearch(search.env, undefined, true) })
                }
              />
            }
          >
            <PlusIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup>
            <T>New bot</T>
          </TooltipPopup>
        </Tooltip>
      </div>
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
                  selected ? "bg-update/10 ring-1 ring-inset ring-update/40" : "hover:bg-accent/60",
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
    </SidebarContent>
  );
}

const EMPTY_ACTIVITY: BotActivity = { lastAt: null, lastTitle: null, running: false };
