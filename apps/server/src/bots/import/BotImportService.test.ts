import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotId,
  BotProfile,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import { BotStore, layer as botStoreLayer } from "../BotStore.ts";
import { BotImportService, layer as botImportLayer } from "./BotImportService.ts";
import { scanFolderSource, scanOpenBotDb } from "./sources.ts";

const decodeProfile = Schema.decodeUnknownSync(BotProfile);
const parseJson = (text: string): unknown => JSON.parse(text);
const stringify = (value: unknown): string => JSON.stringify(value);

const profile = (id: string, name: string): BotProfile =>
  decodeProfile({
    id,
    name,
    enabled: true,
    projectId: "project-1",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "devin", model: "swe-2-high" },
    approvalMode: "full",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

const devinProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("devin"),
  driver: ProviderDriverKind.make("devin"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-13T00:00:00.000Z",
  models: [
    { slug: "swe-2-high", name: "SWE-2 High", isCustom: false, capabilities: null },
    { slug: "swe-1.6", name: "SWE-1.6", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

const fallbackModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("devin"),
  model: "swe-2-high",
};

const task = (over: Partial<ScheduledTask> & { botId?: BotId | undefined }): ScheduledTask => ({
  id: "task-1" as ScheduledTask["id"],
  title: "Routine",
  prompt: "Do it.",
  enabled: true,
  schedule: { type: "fixed_time", timeOfDay: "08:44", weekdays: [1, 2, 3, 4, 5] },
  projectId: "project-1" as ScheduledTask["projectId"],
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: fallbackModel,
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
  ...over,
});

interface ImportContext {
  readonly svc: BotImportService["Service"];
  readonly store: BotStore["Service"];
  readonly calls: Ref.Ref<ReadonlyArray<ScheduledTaskUpsertInput>>;
  readonly baseDir: string;
}

const withImport = <A, E>(
  input: {
    providers?: ReadonlyArray<ServerProvider>;
    tasks?: ReadonlyArray<ScheduledTask>;
  },
  body: (ctx: ImportContext) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "simplycode-bot-import-" });
    const calls = yield* Ref.make<ReadonlyArray<ScheduledTaskUpsertInput>>([]);
    const serviceLayer = botImportLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          botStoreLayer.pipe(Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir))),
          Layer.mock(ScheduledTasks.ScheduledTaskService)({
            upsert: (taskInput) =>
              Ref.update(calls, (existing) => [...existing, taskInput]).pipe(
                Effect.as({ task: undefined } as never),
              ),
            list: () => Effect.succeed({ tasks: input.tasks ?? [] }),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed(input.providers ?? []),
          }),
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeedSome({} as never),
          }),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const svc = yield* BotImportService;
      const store = yield* BotStore;
      return yield* body({ svc, store, calls, baseDir });
    }).pipe(Effect.provide(serviceLayer));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect("reads agents, memories, skills and routines from an OpenBot database copy", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "openbot-fixture-" });
    const dbFile = path.join(dir, "openbot.db");
    const workspace = path.join(dir, "agent-one");
    yield* fs.makeDirectory(path.join(workspace, ".agents", "skills", "helper"), {
      recursive: true,
    });
    yield* fs.writeFileString(path.join(workspace, "AGENTS.md"), "Be helpful.");
    yield* fs.writeFileString(
      path.join(workspace, ".agents", "skills", "helper", "SKILL.md"),
      "---\nname: helper\n---\nHelp with things.",
    );

    const db = new NodeSqlite.DatabaseSync(dbFile);
    db.exec(`CREATE TABLE projection_agents (agent_json TEXT, sort_order INTEGER);
      CREATE TABLE projection_agent_memories (id TEXT PRIMARY KEY, agent_id TEXT, text TEXT, created_at TEXT);
      CREATE TABLE agent_memory_selections (memory_id TEXT, inclusion TEXT);
      CREATE TABLE projection_agent_routines (routine_id TEXT, agent_id TEXT, name TEXT, instruction TEXT, active INTEGER, timezone TEXT);
      CREATE TABLE projection_routine_triggers (routine_id TEXT, schedule_json TEXT);`);
    const insertAgent = db.prepare("INSERT INTO projection_agents VALUES (?, ?)");
    insertAgent.run(
      stringify({
        id: "a1",
        name: "Chief",
        title: "The Boss",
        description: "Leads.",
        model: "swe-2-high",
        provider: "devin",
        access: "full",
        reasoningEffort: "max",
        avatarHue: 200,
        workspacePath: workspace,
      }),
      0,
    );
    insertAgent.run(stringify({ id: "a2", name: "Dev", provider: "codex", model: "gpt-5.4" }), 1);
    const insertMemory = db.prepare("INSERT INTO projection_agent_memories VALUES (?, ?, ?, ?)");
    insertMemory.run("m1", "a1", "Likes coffee", "2026-01-02T00:00:00Z");
    insertMemory.run("m2", "a1", "Codes in the dark", "2026-01-01T00:00:00Z");
    const insertSelection = db.prepare("INSERT INTO agent_memory_selections VALUES (?, ?)");
    insertSelection.run("m1", "searchable");
    insertSelection.run("m2", "essential");
    const insertRoutine = db.prepare(
      "INSERT INTO projection_agent_routines VALUES (?, ?, ?, ?, ?, ?)",
    );
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    insertRoutine.run("r1", "a1", "Morning digest", "Send the digest", 1, zone);
    insertRoutine.run("r2", "a1", "Weekly review", "Review the week", 1, zone);
    insertRoutine.run("r3", "a1", "Hourly ping", "Ping", 1, zone);
    const insertTrigger = db.prepare("INSERT INTO projection_routine_triggers VALUES (?, ?)");
    insertTrigger.run("r1", stringify({ kind: "weekdays", time: "08:44" }));
    insertTrigger.run("r2", stringify({ kind: "weekly", weekday: 1, time: "08:49" }));
    insertTrigger.run("r3", stringify({ kind: "hourly", intervalMinutes: 60 }));
    db.close();

    const bytesBefore = yield* fs.readFile(dbFile);
    const result = yield* scanOpenBotDb(dbFile);
    const bytesAfter = yield* fs.readFile(dbFile);
    expect(Buffer.from(bytesAfter).equals(Buffer.from(bytesBefore))).toBe(true);

    expect(result.sourceLabel).toBe("OpenBot");
    expect(result.bots).toHaveLength(2);
    const chief = result.bots[0]!;
    expect(chief.key).toBe("a1");
    expect(chief.name).toBe("Chief");
    expect(chief.role).toBe("The Boss");
    expect(chief.description).toBe("Leads.");
    expect(chief.approvalMode).toBe("full");
    expect(chief.sourceModel).toBe("swe-2-high (devin)");
    expect(chief.soul).toBe("Be helpful.");
    // Essential first, then by created_at.
    expect(chief.memory).toBe("- Codes in the dark\n- Likes coffee");
    expect(chief.skills.map((skill) => skill.name)).toEqual(["helper"]);
    expect(chief.avatar?.color).toBe("#06b6d4");
    expect(chief.warnings).toContain("Thinking level was not carried over.");

    const [weekdays, weekly, hourly] = chief.automations;
    expect(weekdays).toMatchObject({
      name: "Morning digest",
      prompt: "Send the digest",
      importable: true,
      schedule: { type: "fixed_time", timeOfDay: "08:44", weekdays: [1, 2, 3, 4, 5] },
    });
    expect(weekly).toMatchObject({
      importable: true,
      schedule: { type: "fixed_time", timeOfDay: "08:49", weekdays: [1] },
    });
    expect(hourly).toMatchObject({ importable: false, schedule: undefined });

    const dev = result.bots[1]!;
    expect(dev.approvalMode).toBe("ask");
    expect(dev.automations).toHaveLength(0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reads a single agent folder, then a multi-agent parent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "folder-source-" });
    const single = path.join(dir, "night-watch");
    yield* fs.makeDirectory(path.join(single, "skills", "scout"), { recursive: true });
    yield* fs.writeFileString(
      path.join(single, "AGENTS.md"),
      "---\nname: Night Watch\n---\nStand guard.",
    );
    yield* fs.writeFileString(path.join(single, "MEMORY.md"), "Remembers things.");
    yield* fs.writeFileString(path.join(single, "skills", "scout", "SKILL.md"), "Scout.");

    const scannedSingle = yield* scanFolderSource(single);
    expect(scannedSingle.bots).toHaveLength(1);
    const bot = scannedSingle.bots[0]!;
    expect(bot.name).toBe("Night Watch");
    expect(bot.soul).toContain("Stand guard.");
    expect(bot.memory).toBe("Remembers things.");
    expect(bot.skills.map((skill) => skill.name)).toEqual(["scout"]);

    const parent = path.join(dir, "team");
    for (const child of ["alpha-bot", "beta-bot"]) {
      yield* fs.makeDirectory(path.join(parent, child), { recursive: true });
      yield* fs.writeFileString(path.join(parent, child, "SOUL.md"), `I am ${child}.`);
    }
    const scannedParent = yield* scanFolderSource(parent);
    expect(scannedParent.bots.map((entry) => entry.name).sort()).toEqual(["Alpha Bot", "Beta Bot"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const packageJson = (bots: ReadonlyArray<unknown>) =>
  stringify({ format: "simplycode-bots", version: 1, bots });

it.effect("exports and re-imports a bot with soul, memory, skills and automations", () =>
  withImport(
    {
      providers: [devinProvider],
      tasks: [
        task({ id: "task-a" as ScheduledTask["id"], botId: BotId.make("dev") }),
        task({
          id: "task-b" as ScheduledTask["id"],
          botId: BotId.make("dev"),
          schedule: { type: "webhook" } as never,
        }),
      ],
    },
    ({ svc, store, calls }) =>
      Effect.gen(function* () {
        yield* store.write(profile("dev", "Dev"), "Be dev.", "remember me");
        yield* store.installSkillFiles(BotId.make("dev"), BotId.make("helper"), [
          { path: "SKILL.md", data: Buffer.from("---\nname: helper\n---\nHelp.") },
          { path: "blob.bin", data: Uint8Array.from([0, 1, 2, 255]) },
        ]);

        const exported = yield* svc.exportBots({
          ids: [BotId.make("dev")],
          includeMemory: true,
        });
        expect(exported.fileName).toBe("dev.simplycode-bots.json");
        const parsed = parseJson(exported.content) as {
          bots: [{ automations: unknown[]; skills: { files: unknown[] }[]; memory?: string }];
        };
        // The webhook task is skipped.
        expect(parsed.bots[0]!.automations).toHaveLength(1);
        expect(parsed.bots[0]!.memory).toBe("remember me");
        expect(parsed.bots[0]!.skills[0]!.files).toHaveLength(2);

        const scanned = yield* svc.scan({
          source: { type: "package", content: exported.content },
        });
        expect(scanned.candidates).toHaveLength(1);
        const candidate = scanned.candidates[0]!;
        expect(candidate.name).toBe("Dev");
        expect(candidate.skills).toEqual(["helper"]);
        expect(candidate.automations).toHaveLength(1);
        expect(candidate.automations[0]!.importable).toBe(true);
        expect(candidate.memoryBytes).toBeGreaterThan(0);

        const applied = yield* svc.apply({
          source: { type: "package", content: exported.content },
          keys: [candidate.key],
          projectId: "project-1" as never,
          fallbackModelSelection: fallbackModel,
          include: { memory: true, skills: true, automations: true },
        });
        expect(applied.bots).toHaveLength(1);
        const copy = applied.bots[0]!;
        expect(copy.id).toBe("dev-2");
        const got = yield* store.get(copy.id);
        expect(got.soul).toBe("Be dev.");
        expect(got.memory).toBe("remember me");
        expect(got.skills.map((skill) => skill.name)).toEqual(["helper"]);

        const upserts = yield* Ref.get(calls);
        expect(upserts).toHaveLength(1);
        expect(upserts[0]).toMatchObject({ enabled: false, botId: "dev-2", title: "Routine" });
      }),
  ),
);

it.effect("rejects packages with unsafe skill paths, oversize and wrong shape", () =>
  withImport({}, ({ svc }) =>
    Effect.gen(function* () {
      for (const filePath of ["../escape.txt", "/abs/path.txt", "C:\\win.txt", "a/../b.txt"]) {
        const content = packageJson([
          {
            profile: { name: "Bad" },
            soul: "x",
            skills: [{ name: "evil", files: [{ path: filePath, text: "x" }] }],
          },
        ]);
        const result = yield* svc.scan({ source: { type: "package", content } });
        expect(result.candidates).toHaveLength(0);
        expect(result.warnings[0]).toContain("rejected");
      }

      const oversize = yield* svc
        .scan({ source: { type: "package", content: "x".repeat(10 * 1024 * 1024 + 1) } })
        .pipe(Effect.result);
      expect(oversize._tag).toBe("Failure");

      const wrong = yield* svc
        .scan({ source: { type: "package", content: "{}" } })
        .pipe(Effect.result);
      expect(wrong._tag).toBe("Failure");
      if (wrong._tag === "Failure") {
        expect(wrong.failure.message).toContain("SimplyCode bots package");
      }
    }),
  ),
);

it.effect("maps source models, falls back otherwise, and warns per failed bot", () =>
  withImport({ providers: [devinProvider] }, ({ svc, calls }) =>
    Effect.gen(function* () {
      const content = packageJson([
        {
          profile: {
            name: "Mapped",
            modelSelection: { instanceId: "devin", model: "swe-2-high" },
          },
          soul: "mapped",
        },
        {
          profile: {
            name: "Unmapped",
            modelSelection: { instanceId: "cursor", model: "gpt-9" },
          },
          soul: "unmapped",
        },
        {
          profile: {
            name: "Alien",
            modelSelection: { instanceId: "devin", model: "not-a-model" },
          },
          soul: "alien",
        },
      ]);
      const scanned = yield* svc.scan({ source: { type: "package", content } });
      const [mapped, unmapped, alien] = scanned.candidates;
      expect(mapped!.modelSelection).toEqual({
        instanceId: "devin",
        model: "swe-2-high",
      });
      expect(unmapped!.modelSelection).toBeUndefined();
      expect(unmapped!.sourceModel).toBe("gpt-9 (cursor)");
      expect(alien!.modelSelection).toBeUndefined();

      // One bot whose name the profile schema rejects imports the rest anyway.
      const badContent = packageJson([
        { profile: { name: "Good Bot" }, soul: "fine" },
        { profile: { name: "bad\nname" }, soul: "bad" },
      ]);
      const badScan = yield* svc.scan({ source: { type: "package", content: badContent } });
      const applied = yield* svc.apply({
        source: { type: "package", content: badContent },
        keys: badScan.candidates.map((candidate) => candidate.key),
        projectId: "project-1" as never,
        fallbackModelSelection: fallbackModel,
        include: { memory: false, skills: false, automations: false },
      });
      expect(applied.bots.map((bot) => bot.name)).toEqual(["Good Bot"]);
      expect(applied.warnings.some((w) => w.includes("could not be imported"))).toBe(true);

      const appliedModels = yield* svc.apply({
        source: { type: "package", content },
        keys: scanned.candidates.map((candidate) => candidate.key),
        projectId: "project-1" as never,
        fallbackModelSelection: fallbackModel,
        include: { memory: false, skills: false, automations: false },
      });
      const [importedMapped, importedUnmapped] = appliedModels.bots;
      expect(importedMapped!.modelSelection).toEqual({ instanceId: "devin", model: "swe-2-high" });
      expect(importedUnmapped!.modelSelection).toEqual({
        instanceId: "devin",
        model: "swe-2-high",
      });
      const upserts = yield* Ref.get(calls);
      expect(upserts).toHaveLength(0);
    }),
  ),
);

it.effect("name collisions get suffixed ids", () =>
  withImport({}, ({ svc, store }) =>
    Effect.gen(function* () {
      yield* store.write(profile("dev", "Dev"));
      const content = packageJson([{ profile: { name: "Dev" }, soul: "s" }]);
      const first = yield* svc.apply({
        source: { type: "package", content },
        keys: ["bot-0"],
        projectId: "project-1" as never,
        fallbackModelSelection: fallbackModel,
        include: { memory: false, skills: false, automations: false },
      });
      const second = yield* svc.apply({
        source: { type: "package", content },
        keys: ["bot-0"],
        projectId: "project-1" as never,
        fallbackModelSelection: fallbackModel,
        include: { memory: false, skills: false, automations: false },
      });
      expect(first.bots[0]!.id).toBe("dev-2");
      expect(second.bots[0]!.id).toBe("dev-3");
    }),
  ),
);
