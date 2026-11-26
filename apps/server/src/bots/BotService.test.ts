import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotId,
  BotProfile,
  type BotUpsertInput,
  CommandId,
  Pipeline,
  ProjectId,
  ProviderInstanceId,
  ScheduledTask,
  ScheduledTaskId,
  TeamId,
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
import * as PipelineStore from "./PipelineStore.ts";
import * as TeamStore from "./TeamStore.ts";

const decodeTask = Schema.decodeUnknownSync(ScheduledTask);
const decodeProfile = Schema.decodeUnknownSync(BotProfile);
const decodePipeline = Schema.decodeUnknownSync(Pipeline);

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
    readonly workspaceConfined: boolean | undefined;
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
    | BotService.BotService
    | BotStore.BotStore
    | TeamStore.TeamStore
    | PipelineStore.PipelineStore
    | FileSystem.FileSystem
    | Path.Path
    | Scope.Scope
  >,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-botsvc-" });
    const botStoreLayer = BotStore.layer.pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
    const teamStoreLayer = TeamStore.layer.pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
    const pipelineStoreLayer = PipelineStore.layer.pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provideMerge(NodeServices.layer)),
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
            workspaceConfined: input.workspaceConfined,
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
          teamStoreLayer,
          pipelineStoreLayer,
          scheduledTasksMock,
          threadLaunchMock,
          orchestratorMock,
          projectStoreMock,
        ),
      ),
    );
    return yield* body.pipe(
      Effect.provide(
        Layer.mergeAll(serviceLayer, botStoreLayer, teamStoreLayer, pipelineStoreLayer),
      ),
    );
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

      // stayInProject defaults on for a new bot, and an update that leaves it
      // out keeps the stored value rather than resetting it.
      expect(created.bot.stayInProject).toBe(true);
      yield* service.upsert(upsertInput({ id: created.bot.id, stayInProject: false }));
      yield* service.upsert(upsertInput({ id: created.bot.id, role: "Watcher" }));
      const stayed = yield* service.get({ id: created.bot.id });
      expect(stayed.bot.stayInProject).toBe(false);
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
      expect(launch?.workspaceConfined).toBe(true);
      expect(launch?.title).toBe("Night Watch: Check it.");
      expect(launch?.text).toBe(
        'You are "Night Watch", a SimplyCode bot. Follow these standing instructions:\n\nAlways be terse.\n\n## Your memory\nThis is your MEMORY.md, kept between runs. When you learn something worth keeping (a user preference, a project fact, a lesson from a mistake), save it with the update_bot_memory tool (on the t3-code MCP server; if your MCP tools are listed separately, look there). Keep it short and current.\n\n(empty)\n\n--- end of standing instructions ---\n\nCheck it.',
      );
      const tag = seen.dispatches.find((command) => command.type === "thread.tag.set");
      expect(tag?.tag).toBe("bot:night-watch");
      expect(tag?.tagged).toBe(true);

      // A bot that stays out of its project launches an unconfined thread.
      yield* store.write({ ...profileFixture("nomad"), stayInProject: false });
      yield* service.runNow({ id: "nomad" as never, prompt: "Roam." });
      expect(seen.launches[1]?.workspaceConfined).toBe(false);
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

it.effect("refuses to delete a bot a team or pipeline still uses", () =>
  withService(
    [],
    harness(),
    Effect.gen(function* () {
      const service = yield* BotService.BotService;
      const store = yield* BotStore.BotStore;
      const teamStore = yield* TeamStore.TeamStore;
      const pipelineStore = yield* PipelineStore.PipelineStore;
      yield* store.write(profileFixture("member-bot"));
      yield* store.write(profileFixture("lead-bot"));
      yield* store.write(profileFixture("stage-bot"));
      yield* store.write(profileFixture("free-bot"));

      yield* teamStore.write({
        id: TeamId.make("build"),
        name: "Build",
        leadBotId: BotId.make("lead-bot"),
        memberBotIds: [BotId.make("member-bot")],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      yield* pipelineStore.write(
        decodePipeline({
          id: "ship",
          teamId: "build",
          name: "Ship",
          stages: [
            { id: "dev", name: "Dev", botId: "stage-bot", kind: "work", instructions: "Do it." },
          ],
          limits: { maxRounds: 3, stageTimeoutMinutes: 60 },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      const member = yield* service.delete({ id: "member-bot" as never }).pipe(Effect.flip);
      expect(member.message).toBe(
        'This bot is on the team "Build". Remove it from the team first.',
      );
      const lead = yield* service.delete({ id: "lead-bot" as never }).pipe(Effect.flip);
      expect(lead.message).toBe('This bot leads the team "Build". Remove it from the team first.');
      const stage = yield* service.delete({ id: "stage-bot" as never }).pipe(Effect.flip);
      expect(stage.message).toBe(
        'This bot runs a stage of the pipeline "Ship". Change the pipeline first.',
      );

      // A bot nothing references still deletes.
      yield* service.delete({ id: "free-bot" as never });
      const listed = yield* service.list({});
      expect(listed.bots.map((bot) => bot.id)).not.toContain("free-bot");
    }),
  ),
);
