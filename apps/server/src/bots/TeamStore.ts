// Team files live as `<id>.json` under `teams/` in the server home, watched so
// edits land without a restart.
import { BotError, Team, TeamId, type TeamListResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as CollectionStore from "./collectionStore.ts";

export class TeamStore extends Context.Service<
  TeamStore,
  {
    readonly list: () => Effect.Effect<TeamListResult>;
    readonly subscribeList: () => Stream.Stream<TeamListResult>;
    readonly find: (id: TeamId) => Effect.Effect<Team | undefined>;
    readonly write: (team: Team) => Effect.Effect<void, BotError>;
    readonly remove: (id: TeamId) => Effect.Effect<void, BotError>;
    readonly allocateId: (name: string) => Effect.Effect<TeamId>;
    readonly watchReady: Effect.Effect<void>;
  }
>()("simplycode/bots/TeamStore") {}

const decodeTeam = Schema.decodeUnknownEffect(Team);
const decodeTeamId = Schema.decodeUnknownOption(TeamId);

export const layer = Layer.effect(
  TeamStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const store = yield* CollectionStore.makeCollectionStore({
      directory: config.teamsDir,
      kind: "team",
      decode: decodeTeam,
      decodeId: (value) => {
        const decoded = decodeTeamId(value);
        return decoded._tag === "Some" ? decoded.value : undefined;
      },
    });
    return TeamStore.of({
      list: Effect.fn("TeamStore.list")(function* () {
        const [teams, loadErrors] = yield* Effect.all([store.items(), store.loadErrors()]);
        return { teams, loadErrors } satisfies TeamListResult;
      }),
      subscribeList: () =>
        store.changes.pipe(
          Stream.map((current) => ({
            teams: [...current.items.values()],
            loadErrors: [...current.loadErrors],
          })),
        ),
      find: store.find,
      write: store.write,
      remove: store.remove,
      allocateId: store.allocateId,
      watchReady: store.watchReady,
    });
  }),
);
