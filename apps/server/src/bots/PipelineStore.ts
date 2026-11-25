// Pipeline files live as `<id>.json` under `pipelines/` in the server home,
// watched so edits land without a restart.
import { BotError, Pipeline, PipelineId, type PipelineListResult } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as CollectionStore from "./collectionStore.ts";

export class PipelineStore extends Context.Service<
  PipelineStore,
  {
    readonly list: () => Effect.Effect<PipelineListResult>;
    readonly subscribeList: () => Stream.Stream<PipelineListResult>;
    readonly find: (id: PipelineId) => Effect.Effect<Pipeline | undefined>;
    readonly write: (pipeline: Pipeline) => Effect.Effect<void, BotError>;
    readonly remove: (id: PipelineId) => Effect.Effect<void, BotError>;
    readonly allocateId: (name: string) => Effect.Effect<PipelineId>;
    readonly watchReady: Effect.Effect<void>;
  }
>()("simplycode/bots/PipelineStore") {}

const decodePipeline = Schema.decodeUnknownEffect(Pipeline);
const decodePipelineId = Schema.decodeUnknownOption(PipelineId);

export const layer = Layer.effect(
  PipelineStore,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const store = yield* CollectionStore.makeCollectionStore({
      directory: config.pipelinesDir,
      kind: "pipeline",
      decode: decodePipeline,
      decodeId: (value) => {
        const decoded = decodePipelineId(value);
        return decoded._tag === "Some" ? decoded.value : undefined;
      },
    });
    return PipelineStore.of({
      list: Effect.fn("PipelineStore.list")(function* () {
        const [pipelines, loadErrors] = yield* Effect.all([store.items(), store.loadErrors()]);
        return { pipelines, loadErrors } satisfies PipelineListResult;
      }),
      subscribeList: () =>
        store.changes.pipe(
          Stream.map((current) => ({
            pipelines: [...current.items.values()],
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
