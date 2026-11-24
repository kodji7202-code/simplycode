import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { BotId, BotProfile, ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as BotService from "../bots/BotService.ts";
import * as BotStore from "../bots/BotStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ServerActivation } from "../serverActivation.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";

const decodeInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const decodeProfile = Schema.decodeUnknownSync(BotProfile);

const botProfile = (id: string, enabled = true): BotProfile =>
  decodeProfile({
    id,
    name: "Night Watch",
    enabled,
    projectId: "project-1",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    approvalMode: "auto-safe",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

const launchedMessages: Array<{ text: string; freshContext?: boolean }> = [];
const sentMessages: Array<{ text: string; freshContext: boolean | undefined }> = [];
const dispatches: Array<Record<string, unknown>> = [];

const botLayer = (baseDir: string) => {
  const botStoreLayer = BotStore.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(NodeServices.layer, ServerConfig.layerTest(process.cwd(), baseDir)),
    ),
  );
  const hookLayer = BotService.botHookLayer.pipe(
    Layer.provide(
      Layer.merge(
        botStoreLayer,
        Layer.mock(Orchestrator.OrchestratorV2)({
          dispatch: (command) =>
            Effect.sync(() => void dispatches.push(command as Record<string, unknown>) as never),
        }),
      ),
    ),
  );
  const serviceLayer = ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        ManagedPolicy.layerTest(),
        hookLayer,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Effect.sync(() => {
              launchedMessages.push({ text: input.initialMessage?.text ?? "" });
              return {
                threadId: `thread-${launchedMessages.length}`,
              } as unknown as ThreadLaunchService.ThreadLaunchResult;
            }),
          isNonGitProject: () => Effect.succeed(false),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          sendToThread: (input) =>
            Effect.sync(
              () =>
                void sentMessages.push({
                  text: input.text,
                  freshContext: input.freshContext,
                }) as never,
            ),
          getThreadShell: () =>
            Effect.succeed({
              projectId: "project-1",
              deletedAt: null,
              archivedAt: null,
            } as never),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
      ),
    ),
  );
  return Layer.merge(serviceLayer, botStoreLayer);
};

const input = {
  commandId: "bot-task",
  title: "Bot task",
  prompt: "Run the checks.",
  enabled: true,
  projectId: "project-1",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

const withBotServices = <A, E>(
  body: Effect.Effect<A, E, ScheduledTaskService.ScheduledTaskService | BotStore.BotStore>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-taskbot-" });
    launchedMessages.length = 0;
    sentMessages.length = 0;
    dispatches.length = 0;
    return yield* body.pipe(Effect.provide(botLayer(baseDir)));
  }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  );

it.effect("rejects an upsert naming a bot that does not exist", () =>
  withBotServices(
    Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const error = yield* service
        .upsert(
          yield* decodeInput({
            ...input,
            schedule: { type: "interval", everyMs: 60_000 },
            botId: "ghost-bot",
          }),
        )
        .pipe(Effect.flip);
      expect(error.message).toBe("Bot not found.");
    }),
  ),
);

it.effect("wraps the launch prompt and tags the thread for a bot task", () =>
  withBotServices(
    Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* store.write(botProfile("night-watch"), "Stand guard.");
      const created = yield* service.upsert(
        yield* decodeInput({
          ...input,
          schedule: { type: "interval", everyMs: 60_000 },
          botId: "night-watch",
        }),
      );
      expect(created.task.botId).toBe("night-watch");
      expect(created.task.blockedByBot).toBeUndefined();

      yield* service.runNow({ id: created.task.id });
      expect(launchedMessages).toHaveLength(1);
      expect(launchedMessages[0]?.text).toBe(
        'You are "Night Watch", a SimplyCode bot. Follow these standing instructions:\n\nStand guard.\n\n---\n\nRun the checks.',
      );
      const tag = dispatches.find((command) => command.type === "thread.tag.set");
      expect(tag?.tag).toBe("bot:night-watch");
    }),
  ),
);

it.effect("wraps only new-thread and fresh-session sends for a bound task", () =>
  withBotServices(
    Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* store.write(botProfile("night-watch"), "Stand guard.");
      const created = yield* service.upsert(
        yield* decodeInput({
          ...input,
          schedule: { type: "interval", everyMs: 60_000 },
          botId: "night-watch",
          threadId: "thread-bound",
          threadMode: "continue",
        }),
      );

      yield* service.runNow({ id: created.task.id });
      expect(sentMessages[0]?.text).toBe("Run the checks.");
      expect(sentMessages[0]?.freshContext).toBeUndefined();

      yield* service.upsert(
        yield* decodeInput({
          ...input,
          schedule: { type: "interval", everyMs: 60_000 },
          botId: "night-watch",
          threadId: "thread-bound",
          threadMode: "fresh_session",
        }),
      );
      yield* service.runNow({ id: created.task.id });
      expect(sentMessages[1]?.text).toContain("Stand guard.");
      expect(sentMessages[1]?.freshContext).toBe(true);
    }),
  ),
);

it.effect("blocks a task whose bot is disabled until it is re-enabled", () =>
  withBotServices(
    Effect.gen(function* () {
      const store = yield* BotStore.BotStore;
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* store.write(botProfile("night-watch", false));
      const created = yield* service.upsert(
        yield* decodeInput({
          ...input,
          schedule: { type: "interval", everyMs: 60_000 },
          botId: "night-watch",
        }),
      );
      const listed = yield* service.list();
      expect(listed.tasks[0]?.blockedByBot).toBe("Its bot is disabled.");

      const blocked = yield* service.runNow({ id: created.task.id }).pipe(Effect.flip);
      expect(blocked.message).toBe("Its bot is disabled.");
      expect(launchedMessages).toHaveLength(0);
      expect(sentMessages).toHaveLength(0);

      const { bot } = yield* store.get(BotId.make("night-watch"));
      const { soulBytes: _soulBytes, threadTag: _threadTag, ...profile } = bot;
      yield* store.write({ ...profile, enabled: true });
      const fired = yield* service.runNow({ id: created.task.id });
      expect(fired.task.lastRunStatus).toBe("succeeded");
      expect(launchedMessages).toHaveLength(1);
    }),
  ),
);
