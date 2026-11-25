import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  totalTokens,
  type ProviderUsageReader,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import type { AcpRegistrySettings } from "../settings.ts";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tokens(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

// Devin stamps rows in whole seconds today; tolerate a future millisecond column.
function toTimestampMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value > 1e12 ? Math.trunc(value) : Math.trunc(value * 1000);
}

function modelDisplayName(responseDimensions: unknown): string | null {
  if (!Array.isArray(responseDimensions)) return null;
  for (const entry of responseDimensions) {
    if (typeof entry !== "object" || entry === null) continue;
    const dimension = entry as { uid?: unknown; kind?: unknown };
    if (dimension.uid !== "model") continue;
    const kind = dimension.kind as { Metric?: { value?: unknown } } | undefined;
    const value = kind?.Metric?.value;
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

interface DevinNodeRow {
  readonly row_id: number;
  readonly session_id: unknown;
  readonly node_id: unknown;
  readonly created_at: unknown;
  readonly metrics: unknown;
  readonly dims: unknown;
  readonly generation_model: unknown;
}

const parseDevinRow = (
  row: DevinNodeRow,
  sessionModels: ReadonlyMap<string, string>,
): UsageRecord | null => {
  try {
    const metrics =
      typeof row.metrics === "string" ? (JSON.parse(row.metrics) as unknown) : row.metrics;
    const fields =
      typeof metrics === "object" && metrics !== null ? (metrics as Record<string, unknown>) : {};
    const totals = {
      uncachedInputTokens: tokens(fields["input_tokens"]),
      cachedInputTokens: tokens(fields["cache_read_tokens"]),
      cacheCreationTokens: tokens(fields["cache_creation_tokens"]),
      outputTokens: tokens(fields["output_tokens"]),
      reasoningTokens: 0,
    };
    const sessionId = text(row.session_id);
    const model =
      text(row.generation_model) ||
      modelDisplayName(
        typeof row.dims === "string" ? (JSON.parse(row.dims) as unknown) : row.dims,
      ) ||
      sessionModels.get(sessionId) ||
      "";
    const timestampMs = toTimestampMs(row.created_at);
    if (totalTokens(totals) === 0 || model.length === 0 || timestampMs === null) return null;
    return {
      provider: "devin",
      timestampMs,
      model,
      sessionId,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: `devin:${sessionId}:${typeof row.node_id === "number" ? row.node_id : 0}`,
    };
  } catch {
    return null;
  }
};

interface MessageRow {
  readonly rowId: number;
  readonly sessionId: string;
  readonly nodeId: number;
  readonly created: number;
  readonly size: number;
}

interface CachedRow {
  readonly created: number;
  readonly size: number;
  readonly record: UsageRecord | null;
}

// Parsed rows by database path, then row_id: the append-only forest keeps rows stable, so a row
// whose created_at and body length are unchanged is reused without re-reading its JSON.
const rowCache = new Map<string, { identity: string; rows: Map<number, CachedRow> }>();
// Concurrent scans of the same database would each read every uncached row.
const scanLock = Semaphore.makeUnsafe(1);

const MESSAGE_PAGE_SIZE = 64;

export interface DevinUsageReadResult {
  readonly files: readonly { readonly path: string; readonly records: readonly UsageRecord[] }[];
  readonly missing: boolean;
  readonly error: boolean;
}

export const readDevinUsage = Effect.fn("readDevinUsage")(function* (
  dir: string,
  sinceMs: number,
  retentionCutoffMs = sinceMs,
): Effect.fn.Return<DevinUsageReadResult, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dbPath = path.join(dir, "sessions.db");
  const files: { path: string; records: UsageRecord[] }[] = [];
  let error = false;

  const main = yield* Effect.option(fileSystem.stat(dbPath));
  if (Option.isNone(main)) {
    return { files, missing: true, error: false };
  }
  const file = { path: dbPath, records: [] as UsageRecord[] };
  files.push(file);
  // A replaced or restored database can repeat row_ids, so cached rows survive only while the
  // file identity does. Checkpoints change size and mtime but keep every row, so they do not
  // count here; each row's own created_at and length decide reuse instead.
  const stat = main.value;
  const identity = `${stat.dev}:${Option.getOrNull(stat.ino)}:${Option.getOrNull(stat.birthtime)?.getTime()}`;

  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Fail promptly on live-writer locks instead of stalling the server.
    yield* sql.unsafe("PRAGMA busy_timeout = 100");
    const tables = new Set(
      (yield* sql.unsafe<{ readonly name: unknown }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )).map((row) => row.name),
    );
    if (!tables.has("message_nodes")) {
      error = true;
      return;
    }
    const sessionModels = new Map<string, string>();
    if (tables.has("sessions")) {
      const sessions = yield* sql.unsafe<{
        readonly id: unknown;
        readonly model: unknown;
      }>("SELECT id, model FROM sessions");
      for (const session of sessions) {
        const id = text(session.id);
        if (id.length > 0) sessionModels.set(id, text(session.model));
      }
    }
    // List ids and change markers so SQLite can use indexes without reading message bodies.
    const listed = (yield* sql.unsafe<{
      readonly row_id: number;
      readonly session_id: unknown;
      readonly node_id: unknown;
      readonly created_at: unknown;
      readonly size: unknown;
    }>(
      `SELECT row_id, session_id, node_id, created_at, octet_length(chat_message) AS size
         FROM message_nodes WHERE created_at >= ? ORDER BY row_id`,
      [Math.floor(retentionCutoffMs / 1000)],
    )).flatMap((row): MessageRow[] => {
      const size = typeof row.size === "number" && Number.isFinite(row.size) ? row.size : null;
      const created = typeof row.created_at === "number" ? row.created_at : null;
      return size === null || created === null
        ? []
        : [
            {
              rowId: row.row_id,
              sessionId: text(row.session_id),
              nodeId: typeof row.node_id === "number" ? row.node_id : 0,
              created,
              size,
            },
          ];
    });
    yield* Effect.annotateCurrentSpan({
      "usage.database_rows": listed.length,
    });

    const previous = rowCache.get(dbPath);
    const reusable = previous?.identity === identity ? previous.rows : undefined;
    const cached = new Map<number, CachedRow>();
    const misses: MessageRow[] = [];
    for (const row of listed) {
      const hit = reusable?.get(row.rowId);
      if (hit && hit.size === row.size && hit.created === row.created) {
        cached.set(row.rowId, hit);
      } else {
        misses.push(row);
      }
    }
    for (let start = 0; start < misses.length; start += MESSAGE_PAGE_SIZE) {
      const page = misses.slice(start, start + MESSAGE_PAGE_SIZE);
      const rows = yield* sql.unsafe<DevinNodeRow>(
        `SELECT row_id, session_id, node_id, created_at,
           chat_message -> '$.metadata.metrics' AS metrics,
           chat_message -> '$.metadata.response_dimensions' AS dims,
           chat_message ->> '$.metadata.generation_model' AS generation_model
         FROM message_nodes WHERE row_id IN (${page.map(() => "?").join(", ")})
           AND chat_message -> '$.metadata.metrics' IS NOT NULL
         ORDER BY row_id`,
        page.map((row) => row.rowId),
      );
      const parsed = new Map<number, UsageRecord | null>();
      for (const row of rows) {
        parsed.set(row.row_id, parseDevinRow(row, sessionModels));
      }
      // Rows without metrics are cached as empty so they are not read again either.
      for (const row of page) {
        cached.set(row.rowId, {
          created: row.created,
          size: row.size,
          record: parsed.get(row.rowId) ?? null,
        });
      }
      yield* Effect.yieldNow;
    }
    const seen = new Set<string>();
    for (const row of listed) {
      const record = cached.get(row.rowId)!.record;
      if (record === null || record.timestampMs < sinceMs) continue;
      if (record.dedupeKey !== null) {
        if (seen.has(record.dedupeKey)) continue;
        seen.add(record.dedupeKey);
      }
      file.records.push(record);
    }
    rowCache.set(dbPath, { identity, rows: cached });
  }).pipe(
    NodeSqliteClient.readOnly,
    // Run the scan on a reader worker so a large database does not block the server's event loop.
    Effect.provide(
      NodeSqliteClient.layer({ filename: dbPath, readonly: true, readerWorker: true }),
    ),
    Effect.catchTags({
      SqlError: () => {
        error = true;
        return Effect.void;
      },
    }),
  );
  return { files, missing: false, error };
}, scanLock.withPermit);

const resolveDevinDataDirs = Effect.fn("resolveDevinDataDirs")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const roots = environment["DEVIN_DATA_DIR"]
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const candidates: string[] = [];
  if (roots !== undefined && roots.length > 0) {
    // Accept the data directory itself or one holding cli/sessions.db.
    for (const root of roots) {
      const resolved = path.resolve(expandHomePath(root, homeDirectory));
      candidates.push(resolved, path.join(resolved, "cli"));
    }
  } else {
    const appData = environment["APPDATA"]?.trim();
    if (appData !== undefined && appData.length > 0) {
      candidates.push(path.join(appData, "devin", "cli"));
    }
    const xdgConfig = environment["XDG_CONFIG_HOME"]?.trim();
    candidates.push(
      path.join(
        xdgConfig !== undefined && xdgConfig.length > 0 && path.isAbsolute(xdgConfig)
          ? xdgConfig
          : path.join(homeDirectory, ".config"),
        "devin",
        "cli",
      ),
    );
  }
  const canonical = new Set<string>();
  for (const candidate of candidates) {
    canonical.add(
      yield* fileSystem.realPath(candidate).pipe(Effect.orElseSucceed(() => candidate)),
    );
  }
  return [...canonical];
});

export type DevinUsageReaderEnv = FileSystem.FileSystem | Path.Path;

export const devinUsageReader: ProviderUsageReader<AcpRegistrySettings, DevinUsageReaderEnv> = {
  kind: "scan",
  provider: "devin",
  scan: Effect.fn("devinUsageReader.scan")(function* ({
    instances,
    windowStartMs,
    retentionCutoffMs,
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const candidates = new Set<string>();
    for (const instance of instances) {
      for (const dir of yield* resolveDevinDataDirs(instance.environment)) candidates.add(dir);
    }
    // Only a directory holding sessions.db is a real source; with none, the first
    // candidate still reports the source as missing.
    const dirs: string[] = [];
    for (const dir of candidates) {
      const exists = yield* fileSystem
        .exists(path.join(dir, "sessions.db"))
        .pipe(Effect.orElseSucceed(() => false));
      if (exists) dirs.push(dir);
    }
    if (dirs.length === 0) {
      const first = candidates.values().next().value;
      if (first !== undefined) dirs.push(first);
    }
    return yield* Effect.forEach(
      dirs,
      (dir) =>
        readDevinUsage(dir, windowStartMs, retentionCutoffMs).pipe(
          Effect.map((result) => ({
            dir,
            files: result.missing && !result.error ? null : result.files,
            status: result.error ? ("partial" as const) : ("ok" as const),
            ...(result.error ? { message: "Some Devin history could not be read." } : {}),
          })),
        ),
      { concurrency: "unbounded" },
    );
  }),
};
