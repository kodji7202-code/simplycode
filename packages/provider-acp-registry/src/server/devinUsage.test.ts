import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import { devinUsageReader, readDevinUsage } from "./devinUsage.ts";

const openDatabase = (filename: string) =>
  Layer.build(NodeSqliteClient.layer({ filename })).pipe(
    Effect.map(Context.get(SqlClient.SqlClient)),
  );

const DEVIN_SCHEMA = [
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL,
     model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL,
     last_activity_at INTEGER NOT NULL, title TEXT, metadata TEXT)`,
  `CREATE TABLE message_nodes (
     row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
     node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL,
     created_at INTEGER NOT NULL, metadata TEXT)`,
];

const makeDevinDatabase = Effect.fn(function* (dir: string) {
  const path = yield* Path.Path;
  const db = yield* openDatabase(path.join(dir, "sessions.db"));
  for (const statement of DEVIN_SCHEMA) yield* db.unsafe(statement);
  return db;
});

const addSession = (db: SqlClient.SqlClient, id: string, model: string, created = 1780000000) =>
  db.unsafe(
    `INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode,
       created_at, last_activity_at, metadata)
     VALUES (?, '/work', 'api', ?, 'chat', ?, ?, '{"total_credit_cost":0,"total_acu_cost":0.0}')`,
    [id, model, created, created],
  );

const MODEL_DIMENSION = {
  uid: "model",
  kind: { Metric: { label: "Model", value: "SWE-2 High" } },
};

const metricsMessage = (overrides: {
  readonly metrics?: Record<string, unknown> | null;
  readonly generationModel?: string | null;
  readonly dimensions?: readonly unknown[] | null;
  readonly role?: string;
}) => {
  const metadata: Record<string, unknown> = {
    num_tokens: 99,
    request_id: "request-1",
    finish_reason: "stop",
    ...(overrides.metrics !== undefined ? { metrics: overrides.metrics } : {}),
    ...(overrides.dimensions === undefined
      ? { response_dimensions: [MODEL_DIMENSION] }
      : overrides.dimensions !== null
        ? { response_dimensions: overrides.dimensions }
        : {}),
    ...(overrides.generationModel !== undefined && overrides.generationModel !== null
      ? { generation_model: overrides.generationModel }
      : {}),
  };
  return JSON.stringify({
    message_id: "8ab73755-1d1d-4caa-955f-9f28855c6546",
    role: overrides.role ?? "assistant",
    content: "ok",
    metadata,
  });
};

const addNode = (
  db: SqlClient.SqlClient,
  sessionId: string,
  nodeId: number,
  chatMessage: string,
  created = 1780000000,
) =>
  db.unsafe(
    "INSERT INTO message_nodes (session_id, node_id, chat_message, created_at) VALUES (?, ?, ?, ?)",
    [sessionId, nodeId, chatMessage, created],
  );

const STANDARD_METRICS = {
  ttft_ms: null,
  total_time_ms: 1353,
  input_tokens: 168,
  output_tokens: 99,
  cache_read_tokens: 94720,
  cache_creation_tokens: null,
  context_input_tokens: 94888,
};

describe("readDevinUsage", () => {
  it.effect("maps a metrics row to a usage record with the generation model id", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "devin-usage-" });
      const db = yield* makeDevinDatabase(dir);
      yield* addSession(db, "sess-1", "swe-2-high");
      yield* addNode(
        db,
        "sess-1",
        5,
        metricsMessage({ metrics: STANDARD_METRICS, generationModel: "swe-2-high" }),
        1780000123,
      );

      const result = yield* readDevinUsage(dir, 0);
      assert.isFalse(result.error);
      assert.isFalse(result.missing);
      const records = result.files.flatMap((file) => file.records);
      assert.strictEqual(records.length, 1);
      assert.deepStrictEqual(records[0], {
        provider: "devin",
        timestampMs: 1780000123000,
        model: "swe-2-high",
        sessionId: "sess-1",
        totals: {
          uncachedInputTokens: 168,
          cachedInputTokens: 94720,
          cacheCreationTokens: 0,
          outputTokens: 99,
          reasoningTokens: 0,
        },
        reportedCostUsd: null,
        speed: "standard",
        dedupeKey: "devin:sess-1:5",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("skips rows without metrics and rows without tokens", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "devin-usage-" });
      const db = yield* makeDevinDatabase(dir);
      yield* addSession(db, "sess-1", "swe-2-high");
      yield* addNode(db, "sess-1", 1, metricsMessage({ role: "user", metrics: null }));
      yield* addNode(
        db,
        "sess-1",
        2,
        metricsMessage({ metrics: { input_tokens: 0, output_tokens: 0 } }),
      );
      yield* addNode(
        db,
        "sess-1",
        3,
        metricsMessage({ metrics: STANDARD_METRICS, generationModel: "swe-2-high" }),
      );

      const records = (yield* readDevinUsage(dir, 0)).files.flatMap((file) => file.records);
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0]?.dedupeKey, "devin:sess-1:3");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to the response display name, then the session model", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "devin-usage-" });
      const db = yield* makeDevinDatabase(dir);
      yield* addSession(db, "sess-1", "swe-2-high");
      yield* addSession(db, "sess-2", "fusion-fast");
      yield* addNode(
        db,
        "sess-1",
        1,
        metricsMessage({ metrics: STANDARD_METRICS, dimensions: [MODEL_DIMENSION] }),
      );
      yield* addNode(
        db,
        "sess-2",
        1,
        metricsMessage({ metrics: STANDARD_METRICS, dimensions: null }),
      );

      const records = (yield* readDevinUsage(dir, 0)).files.flatMap((file) => file.records);
      assert.deepStrictEqual(
        records.map((record) => [record.dedupeKey, record.model]),
        [
          ["devin:sess-1:1", "SWE-2 High"],
          ["devin:sess-2:1", "fusion-fast"],
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("an incremental rescan reads only new message bodies", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "devin-usage-" });
      const db = yield* makeDevinDatabase(dir);
      yield* addSession(db, "sess-1", "swe-2-high");
      yield* addNode(
        db,
        "sess-1",
        1,
        metricsMessage({ metrics: STANDARD_METRICS, generationModel: "swe-2-high" }),
      );

      const first = yield* readDevinUsage(dir, 0);
      assert.strictEqual(first.files.flatMap((file) => file.records).length, 1);

      let bodyReads = 0;
      const originalAll = NodeSqlite.StatementSync.prototype.all;
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          vi.spyOn(NodeSqlite.StatementSync.prototype, "all").mockImplementation(function (
            this: NodeSqlite.StatementSync,
            ...params
          ) {
            if (this.sourceSQL.includes("metadata.metrics' AS metrics")) bodyReads++;
            return originalAll.apply(this, params);
          }),
        ),
        (spy) => Effect.sync(() => spy.mockRestore()),
      );
      const second = yield* readDevinUsage(dir, 0);
      assert.strictEqual(second.files.flatMap((file) => file.records).length, 1);
      assert.strictEqual(bodyReads, 0);

      yield* addNode(
        db,
        "sess-1",
        2,
        metricsMessage({
          metrics: { ...STANDARD_METRICS, input_tokens: 7 },
          generationModel: "swe-2-high",
        }),
        1780000200,
      );
      const third = yield* readDevinUsage(dir, 0);
      const records = third.files.flatMap((file) => file.records);
      assert.deepStrictEqual(
        records.map((record) => record.dedupeKey),
        ["devin:sess-1:1", "devin:sess-1:2"],
      );
      assert.strictEqual(bodyReads, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a missing database instead of failing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "devin-usage-" });
      const result = yield* readDevinUsage(dir, 0);
      assert.isTrue(result.missing);
      assert.isFalse(result.error);
      assert.deepStrictEqual(result.files, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("devinUsageReader", () => {
  it.effect("reads DEVIN_DATA_DIR roots, including a root holding cli/sessions.db", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "devin-usage-env-" });
      const home = yield* fileSystem.realPath(temp);
      const cliDir = path.join(home, "data", "cli");
      yield* fileSystem.makeDirectory(cliDir, { recursive: true });
      const db = yield* makeDevinDatabase(cliDir);
      yield* addSession(db, "sess-1", "swe-2-high");
      yield* addNode(
        db,
        "sess-1",
        1,
        metricsMessage({ metrics: STANDARD_METRICS, generationModel: "swe-2-high" }),
      );

      if (devinUsageReader.kind !== "scan") throw new Error("Expected a scan reader");
      const sources = yield* devinUsageReader
        .scan({
          instances: [
            {
              instanceId: ProviderInstanceId.make("devin"),
              config: undefined,
              environment: { DEVIN_DATA_DIR: path.join(home, "data") },
              configured: true,
            },
            {
              instanceId: ProviderInstanceId.make("devin-cli-dir"),
              config: undefined,
              environment: { DEVIN_DATA_DIR: cliDir },
              configured: true,
            },
          ],
          settings: DEFAULT_SERVER_SETTINGS,
          windowStartMs: 0,
          retentionCutoffMs: 0,
          awaitRefresh: true,
        })
        .pipe(
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(HostProcess.HomeDirectory, home),
        );
      // Both overrides resolve to the same cli directory, scanned once.
      assert.strictEqual(sources.length, 1);
      const source = sources[0]!;
      assert.strictEqual(source.dir, cliDir);
      const records = source.files?.flatMap((file) => file.records) ?? [];
      assert.strictEqual(records.length, 1);
      assert.strictEqual(records[0]?.provider, "devin");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
