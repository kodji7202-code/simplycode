// Teams as a user-facing concept: which bots work together and who leads them.
// The service owns validation (members exist, no duplicates) and the rule that
// a team with pipelines cannot be deleted, so every entry point — RPC now, MCP
// later — gets the same checks.
import {
  type BotId,
  BotError,
  type Team,
  type TeamDeleteInput,
  type TeamDeleteResult,
  type TeamListInput,
  type TeamListResult,
  type TeamMutationResult,
  type TeamUpsertInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

import { BotStore } from "./BotStore.ts";
import { PipelineStore } from "./PipelineStore.ts";
import { TeamStore } from "./TeamStore.ts";

const teamError = (message: string) => new BotError({ message });

export class TeamService extends Context.Service<
  TeamService,
  {
    readonly list: (input: TeamListInput) => Effect.Effect<TeamListResult>;
    readonly subscribeList: (input: TeamListInput) => Stream.Stream<TeamListResult, BotError>;
    readonly upsert: (input: TeamUpsertInput) => Effect.Effect<TeamMutationResult, BotError>;
    readonly delete: (input: TeamDeleteInput) => Effect.Effect<TeamDeleteResult, BotError>;
  }
>()("simplycode/bots/TeamService") {}

export const layer = Layer.effect(
  TeamService,
  Effect.gen(function* () {
    const store = yield* TeamStore;
    const botStore = yield* BotStore;
    const pipelineStore = yield* PipelineStore;

    const requireBot = Effect.fnUntraced(function* (id: BotId, what: string) {
      const bot = yield* botStore.find(id);
      if (bot === undefined) {
        return yield* teamError(`${what} bot "${id}" was not found.`);
      }
      return bot;
    });

    const upsert: TeamService["Service"]["upsert"] = Effect.fn("TeamService.upsert")(
      function* (input) {
        const seen = new Set<BotId>();
        for (const memberId of input.memberBotIds) {
          if (seen.has(memberId)) {
            return yield* teamError(`Bot "${memberId}" is a member twice.`);
          }
          seen.add(memberId);
          yield* requireBot(memberId, "Member");
        }
        if (input.leadBotId !== undefined) {
          yield* requireBot(input.leadBotId, "Lead");
        }
        const existing = input.id === undefined ? undefined : yield* store.find(input.id);
        if (input.id !== undefined && existing === undefined) {
          return yield* teamError("Team not found.");
        }
        const id =
          input.id ??
          (yield* store
            .allocateId(input.name)
            .pipe(Effect.mapError(() => teamError("Could not allocate a team id."))));
        const now = DateTime.formatIso(yield* DateTime.now);
        const team: Team = {
          id,
          name: input.name,
          memberBotIds: input.memberBotIds,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.leadBotId === undefined ? {} : { leadBotId: input.leadBotId }),
        };
        yield* store.write(team);
        return { team };
      },
    );

    const deleteTeam: TeamService["Service"]["delete"] = Effect.fn("TeamService.delete")(
      function* (input) {
        const team = yield* store.find(input.id);
        if (team === undefined) return yield* teamError("Team not found.");
        const { pipelines } = yield* pipelineStore.list();
        for (const pipeline of pipelines) {
          if (pipeline.teamId === input.id) {
            return yield* teamError(
              `A pipeline still uses this team: "${pipeline.name}". Delete it first.`,
            );
          }
        }
        yield* store.remove(input.id);
        return { id: input.id };
      },
    );

    return TeamService.of({
      list: Effect.fn("TeamService.list")(() => store.list()),
      subscribeList: () => store.subscribeList(),
      upsert,
      delete: deleteTeam,
    });
  }),
);
