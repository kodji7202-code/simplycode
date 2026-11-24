import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("112_ScheduledTaskBotId", (it) => {
  it.effect("keeps existing scheduled tasks and adds a nullable bot_id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 111 });
      yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
        task_id: "existing",
        title: "task",
        prompt: "Run",
        enabled: 1,
        schedule_json: '{"type":"interval","everyMs":60000}',
        project_id: "project",
        thread_id: null,
        thread_mode: "continue",
        workspace_strategy_json: '{"type":"root"}',
        model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_by: "user",
        creation_source: "web",
        created_at: "2026-10-01T00:00:00.000Z",
        updated_at: "2026-10-01T00:00:00.000Z",
        next_run_at: null,
        last_run_at: null,
        last_run_status: "never",
        last_run_error: null,
        run_count: 0,
        webhook_token: null,
        webhook_secret: null,
      })}`;
      yield* runMigrations({ toMigrationInclusive: 112 });

      const rows = yield* sql<{
        task_id: string;
        thread_mode: string;
        bot_id: string | null;
      }>`SELECT task_id, thread_mode, bot_id FROM scheduled_tasks`;
      assert.deepEqual(rows, [{ task_id: "existing", thread_mode: "continue", bot_id: null }]);
    }),
  );
});
