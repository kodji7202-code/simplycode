import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotProfile,
  type BotUpsertInput,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTask,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ServerConfig from "../config.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as BotStore from "./BotStore.ts";
import * as BotService from "./BotService.ts";

const decodeTask = Schema.decodeUnknownSync(ScheduledTask);
const decodeProfile = Schema.decodeUnknownSync(BotProfile);

const profileFixture = (id: string, projectId = "project-1"): BotProfile =>
  decodeProfile({
    id,
    name: "Night Watch",
    enabled: true,
    projectId,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    approvalMode: "auto-safe",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

const upsertInput = (over: Partial<BotUpsertInput> = {}): BotUpsertInput => ({
  name: "Night Watch",
  enabled: true,
  projectId: ProjectId.make("project-1"),
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  approvalMode: "auto-safe",
  ...over,
});

const taskWith = (id: string, botId?: string): ScheduledTask =>
  decodeTask({
    id,
    title: "task",
    prompt: "Run",
    enabled: true,
    schedule: { type: "interval", everyMs: 60_000 },
    projectId: "project-1",
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
    ...(botId === undefined ? {} : { botId }),
  });

interface Harness {
  readonly deletedTaskIds: Array<ScheduledTaskId>;
  readonly launches: Array<{
    readonly commandId: CommandId;
    readonly text: string;
    readonly runtimeMode: string;
    readonly title: string;
  }>;
  readonly dispatches: Array<Record<string, unknown>>;
  readonly threadByCommandId: Map<string, string>;
}

const harness = (): Harness => ({
  deletedTaskIds: [],
  launches: [],
  dispatches: [],
  threadByCommandId: new Map(),
});

let launchSequence = 0;

const withService = <A, E>(
  tasks: ReadonlyArray<ScheduledTask>,
  seen: Harness,
  body: Effect.Effect<
    A,
    E,
    BotService.BotService | BotStore.BotStore | FileSystem.FileSystem | Path.Path | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-botsvc-" });
    const botStoreLayer = BotStore.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(NodeServices.layer, ServerConfig.layerTest(process.cwd(), baseDir)),
      ),
    );
    const scheduledTasksMock = Layer.mock(ScheduledTasks.ScheduledTaskService)({
      list: () => Effect.succeed({ tasks }),
      delete: (input) =>
        Effect.sync(() => {
          seen.deletedTaskIds.push(input.id);
          return { id: input.id };
        }),
    });
    const threadLaunchMock = Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) =>
        Effect.sync(() => {
          const replayed = seen.threadByCommandId.get(input.commandId);
          if (replayed !== undefined) {
            return {
              threadId: ThreadId.make(replayed),
            } as unknown as ThreadLaunchService.ThreadLaunchResult;
          }
          const threadId = `thread-${++launchSequence}`;
          seen.threadByCommandId.set(input.commandId, threadId);
          seen.launches.push({
            commandId: input.commandId,
            text: input.initialMessage?.text ?? "",
            runtimeMode: input.runtimeMode,
            title: input.title,
          });
          return { threadId } as unknown as ThreadLaunchService.ThreadLaunchResult;
        }),
    });
    const orchestratorMock = Layer.mock(Orchestrator.OrchestratorV2)({
      dispatch: (command) =>
        Effect.sync(() => void seen.dispatches.push(command as Record<string, unknown>) as never),
    });
    const projectStoreMock = Layer.mock(ProjectStore.ProjectStoreV2)({
      get: (projectId) =>
        Effect.succeed(
          projectId === "project-missing"
            ? Option.none()
            : Option.some({ id: projectId } as unknown as ProjectStore.ProjectRow),
        ),
    });
    const serviceLayer = BotService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          botStoreLayer,
          scheduledTasksMock,
          threadLaunchMock,
          orchestratorMock,
          projectStoreMock,
        ),
      ),
    );
    return yield* body.pipe(Effect.provide(Layer.merge(serviceLayer, botStoreLayer)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("creates a bot with a slug id and keeps the soul on update", () =>
  withService(
    [],
    harness(),
    Effect.gen(function* () {
      const service = yield* BotService.BotService;
      const created = yield* service.upsert(
        upsertInput({
          name: "Night Watch",
          soul: "Stand guard.",
          avatar: { shape: "circle", color: "#3b82f6" },
          role: "Watcher",
          pinned: true,
        }),
      );
      expect(created.bot.id).toBe("night-watch");
      expect(created.bot.avatar).toEqual({ shape: "circle", color: "#3b82f6" });
      expect(created.bot.role).toBe("Watcher");
      expect(created.bot.pinned).toBe(true);
      const again = yield* service.upsert(upsertInput({ name: "night watch" }));
      expect(again.bot.id).toBe("night-watch-2");

      // Omitting pinned keeps the stored value; empty strings still clear role.
      yield* service.upsert(upsertInput({ id: created.bot.id, description: "Stays.", role: "" }));
      const got = yield* service.get({ id: created.bot.id });
      expect(got.soul).toBe("Stand guard.");
      expect(got.bot.description).toBe("Stays.");
      expect(got.bot.pinned).toBe(true);
      expect(got.bot.role).toBe("");
    }),
  ),
);

it.effect("deletes only the deleted bot's scheduled tasks", () => {
  const seen = harness();
  return withService(
    [taskWith("task-a", "bot-one"), taskWith("task-b", "bot-two"), taskWith("task-c")],
    seen,
    Effect.gen(function* () {
      const service = yield* BotService.BotService;
      const store = yield* BotStore.BotStore;
      yield* store.write({ ...profileFixture("bot-one"), name: "One" });
      yield* store.write({ ...profileFixture("bot-two"), name: "Two" });

      yield* service.delete({ id: "bot-one" as never });
      expect(seen.deletedTaskIds).toEqual(["task-a"]);
      const listed = yield* service.list({});
      expect(listed.bots.map((bot) => bot.id)).toEqual(["bot-two"]);
    }),
  );
});

it.effect("runNow launches with the wrapped prompt, bot mode and a bot tag", () => {
  const seen = harness();
  return withService(
    [],
    seen,
    Effect.gen(function* () {
      const service = yield* BotService.BotService;
      const store = yield* BotStore.BotStore;
      yield* store.write(profileFixture("night-watch"), "Always be terse.");
      const result = yield* service.runNow({ id: "night-watch" as never, prompt: "Check it." });

      expect(result.threadId).toBe("thread-1");
      const launch = seen.launches[0];
      expect(launch?.runtimeMode).toBe("auto");
      expect(launch?.title).toBe("Night Watch: Check it.");
      expect(launch?.text).toBe(
        'You are "Night Watch", a SimplyCode bot. Follow these standing instructions:\n\nAlways be terse.\n\n## Your memory\nThis is your MEMORY.md, kept between runs. When you learn something worth keeping (a user preference, a project fact, a lesson from a mistake), save it with the update_bot_memory tool (on the t3-code MCP server; if your MCP tools are listed separately, look there). Keep it short and current.\n\n(empty)\n\n--- end of standing instructions ---\n\nCheck it.',
      );
      const tag = seen.dispatches.find((command) => command.type === "thread.tag.set");
      expect(tag?.tag).toBe("bot:night-watch");
      expect(tag?.tagged).toBe(true);
    }),
  );
});

it.effect("replays a runNow commandId into the same thread", () => {
  const seen = harness();
  return withService(
    [],
    seen,
    Effect.gen(function* () {
      const service = yield* BotService.BotService;
      const store = yield* BotStore.BotStore;
      yield* store.write(profileFixture("night-watch"));
      const commandId = CommandId.make("bot-run-once");
      const first = yield* service.runNow({
        id: "night-watch" as never,
        prompt: "Check it.",
        commandId,
      });
      const second = yield* service.runNow({
        id: "night-watch" as never,
        prompt: "Check it.",
        commandId,
      });
      expect(second.threadId).toBe(first.threadId);
      expect(seen.launches).toHaveLength(1);
    }),
  );
});

it.effect("refuses runNow for a disabled bot and a missing project", () =>
  withService(
    [],
    harness(),
    Effect.gen(function* () {
      const service = yield* BotService.BotService;
      const store = yield* BotStore.BotStore;
      yield* store.write({ ...profileFixture("night-watch"), enabled: false });
      const disabled = yield* service
        .runNow({ id: "night-watch" as never, prompt: "Go." })
        .pipe(Effect.flip);
      expect(disabled.message).toBe("Bot is disabled.");

      // A bot whose project vanished after the profile was written.
      yield* store.write(profileFixture("orphan", "project-missing"));
      const orphaned = yield* service
        .runNow({ id: "orphan" as never, prompt: "Go." })
        .pipe(Effect.flip);
      expect(orphaned.message).toBe("Project not found.");
    }),
  ),
);
