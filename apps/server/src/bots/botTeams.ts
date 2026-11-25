// Which teams a bot leads, as botInstructions shows them: each team with its
// enabled members, for delegate_to_bot.
import type { BotId, Team } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { BotInstructionsTeam } from "./botInstructions.ts";
import type { BotStore } from "./BotStore.ts";
import type { TeamStore } from "./TeamStore.ts";

const teamMembersOf = Effect.fn("botTeams.teamMembersOf")(function* (
  store: BotStore["Service"],
  team: Team,
) {
  const members: Array<BotInstructionsTeam["members"][number]> = [];
  for (const memberId of team.memberBotIds) {
    const member = yield* store.find(memberId);
    if (member === undefined || !member.enabled) continue;
    members.push({
      id: member.id,
      name: member.name,
      ...(member.role === undefined ? {} : { role: member.role }),
      ...(member.description === undefined ? {} : { description: member.description }),
    });
  }
  return members;
});

/** The teams `botId` leads, in `botInstructions` shape. */
export const teamsLedBy = Effect.fn("botTeams.teamsLedBy")(function* (
  store: BotStore["Service"],
  teams: TeamStore["Service"],
  botId: BotId,
) {
  const { teams: all } = yield* teams.list();
  const led: Array<BotInstructionsTeam> = [];
  for (const team of all) {
    if (team.leadBotId !== botId) continue;
    led.push({ name: team.name, members: yield* teamMembersOf(store, team) });
  }
  return led;
});
