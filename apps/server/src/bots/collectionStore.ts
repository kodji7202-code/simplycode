// Shared machinery for a directory of `<id>.json` entity files (teams,
// pipelines), watched so edits land without a restart. A directory that
// cannot be read keeps the last good list rather than looking like every
// entity was deleted.
import { BotError, type BotLoadError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

const WATCH_SETTLE = Duration.millis(100);

export interface CollectionState<Id extends string, A> {
  readonly items: ReadonlyMap<Id, A>;
  readonly loadErrors: ReadonlyArray<BotLoadError>;
}

const slugify = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "item";
};

// JSON helpers stay out of the generators, where a global JSON call is not
// allowed; neither can throw on the data written or read here.
const parseJson = (raw: string): unknown | undefined => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const itemJson = (item: { readonly id: string }) => `${JSON.stringify(item, null, 2)}\n`;

export interface CollectionStore<Id extends string, A extends { readonly id: Id }> {
  readonly items: () => Effect.Effect<ReadonlyArray<A>>;
  readonly loadErrors: () => Effect.Effect<ReadonlyArray<BotLoadError>>;
  readonly changes: Stream.Stream<CollectionState<Id, A>>;
  readonly find: (id: Id) => Effect.Effect<A | undefined>;
  readonly write: (item: A) => Effect.Effect<void, BotError>;
  readonly remove: (id: Id) => Effect.Effect<void, BotError>;
  readonly allocateId: (name: string) => Effect.Effect<Id>;
  /** Completes once the folder watcher is registered (or has failed to be). */
  readonly watchReady: Effect.Effect<void>;
}

export const makeCollectionStore = <Id extends string, A extends { readonly id: Id }>(input: {
  readonly directory: string;
  /** What one entity is called in error messages: "team", "pipeline". */
  readonly kind: string;
  readonly decode: (value: unknown) => Effect.Effect<A, unknown>;
  readonly decodeId: (value: string) => Id | undefined;
}): Effect.Effect<CollectionStore<Id, A>, never, FileSystem.FileSystem | Path.Path | Scope.Scope> =>
  Effect.fn("CollectionStore.make")(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = input.directory;
    const state = yield* SubscriptionRef.make<CollectionState<Id, A>>({
      items: new Map(),
      loadErrors: [],
    });
    const scope = yield* Effect.scope;

    const entityError = (message: string, cause?: unknown) =>
      new BotError({ message, ...(cause === undefined ? {} : { cause }) });

    const filePath = (id: string) => path.join(directory, `${id}.json`);

    const readAll: Effect.Effect<CollectionState<Id, A> | undefined> = Effect.gen(function* () {
      const entries = yield* fileSystem.readDirectory(directory).pipe(
        Effect.map((names) => names.toSorted()),
        Effect.result,
      );
      if (Result.isFailure(entries)) return undefined;
      const items = new Map<Id, A>();
      const loadErrors: Array<BotLoadError> = [];
      for (const entry of entries.success) {
        if (!entry.endsWith(".json")) continue;
        const raw = yield* fileSystem
          .readFileString(path.join(directory, entry))
          .pipe(Effect.result);
        if (Result.isFailure(raw)) {
          loadErrors.push({ folder: entry, message: `${entry} could not be read.` });
          continue;
        }
        const parsed = parseJson(raw.success);
        if (parsed === undefined) {
          loadErrors.push({ folder: entry, message: `${entry} is not valid JSON.` });
          continue;
        }
        const decoded = yield* input.decode(parsed).pipe(
          Effect.mapError((error) => ({
            folder: entry,
            message: `${entry} is not a valid ${input.kind}: ${String(error)}`,
          })),
          Effect.result,
        );
        if (Result.isFailure(decoded)) {
          loadErrors.push(decoded.failure);
          continue;
        }
        if (decoded.success.id !== entry.slice(0, -".json".length)) {
          loadErrors.push({
            folder: entry,
            message: `${entry} id does not match the file name.`,
          });
          continue;
        }
        items.set(decoded.success.id, decoded.success);
      }
      return { items, loadErrors };
    });

    const reload = Effect.suspend(() =>
      readAll.pipe(
        Effect.flatMap((next) =>
          next === undefined
            ? Effect.logWarning(
                `${directory} could not be read; keeping the last good ${input.kind} list`,
              )
            : SubscriptionRef.set(state, next),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning(`Reloading ${input.kind}s failed`, Cause.pretty(cause)),
        ),
      ),
    );

    yield* Effect.ignore(fileSystem.makeDirectory(directory, { recursive: true }));
    yield* reload;

    const watcherReady = yield* Deferred.make<void>();
    const markWatcherReady = () => Deferred.doneUnsafe(watcherReady, Exit.void);
    yield* fileSystem.watch(directory, { recursive: true, onReady: markWatcherReady }).pipe(
      Stream.debounce(WATCH_SETTLE),
      Stream.runForEach(() => reload),
      Effect.catchCause((cause) =>
        Effect.logWarning(`${input.kind} files are not watched for changes`, Cause.pretty(cause)),
      ),
      Effect.ensuring(Effect.sync(markWatcherReady)),
      Effect.forkIn(scope),
    );

    const writeFileAtomic = Effect.fnUntraced(function* (target: string, content: string) {
      const tmp = `${target}.tmp-${process.pid}`;
      yield* fileSystem.writeFileString(tmp, content);
      yield* fileSystem.rename(tmp, target);
    });

    const write = Effect.fn("CollectionStore.write")(function* (item: A) {
      yield* fileSystem
        .makeDirectory(directory, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            entityError(`Could not create the ${input.kind} folder.`, cause),
          ),
        );
      yield* writeFileAtomic(filePath(item.id), itemJson(item)).pipe(
        Effect.mapError((cause) => entityError(`Could not write the ${input.kind}.`, cause)),
      );
      yield* reload;
    });

    const remove = Effect.fn("CollectionStore.remove")(function* (id: Id) {
      yield* fileSystem
        .remove(filePath(id))
        .pipe(
          Effect.mapError((cause) => entityError(`Could not delete the ${input.kind}.`, cause)),
        );
      yield* reload;
    });

    const allocateId = Effect.fn("CollectionStore.allocateId")(function* (name: string) {
      const base = slugify(name);
      const current = yield* SubscriptionRef.get(state);
      for (let suffix = 0; ; suffix++) {
        const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
        const decoded = input.decodeId(candidate);
        if (decoded === undefined) continue;
        if (!current.items.has(decoded)) return decoded;
      }
    });

    return {
      items: Effect.fn("CollectionStore.items")(function* () {
        return [...(yield* SubscriptionRef.get(state)).items.values()];
      }),
      loadErrors: Effect.fn("CollectionStore.loadErrors")(function* () {
        return [...(yield* SubscriptionRef.get(state)).loadErrors];
      }),
      changes: SubscriptionRef.changes(state),
      find: Effect.fn("CollectionStore.find")(function* (id: Id) {
        return (yield* SubscriptionRef.get(state)).items.get(id);
      }),
      write,
      remove,
      allocateId,
      watchReady: Deferred.await(watcherReady),
    };
  })();
