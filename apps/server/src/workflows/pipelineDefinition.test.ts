import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  Bot,
  BotError,
  BotId,
  botThreadTag,
  Pipeline,
  type RuntimeMode,
  Team,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import WorkflowsMigration from "../persistence/Migrations/110_Workflows.ts";
import type { BotStore } from "../bots/BotStore.ts";
import type { PipelineStore } from "../bots/PipelineStore.ts";
import type { TeamStore } from "../bots/TeamStore.ts";
import { type AgentResult, WorkflowAgents } from "./WorkflowAgents.ts";
import * as WorkflowEngine from "./WorkflowEngine.ts";
import * as Workflows from "./Workflows.ts";
import type { WorkflowRunStatus } from "./WorkflowStore.ts";
import {
  makePipelineDefinition,
  PIPELINE_WORKFLOW_NAME,
  type PipelineDefinitionDeps,
} from "./pipelineDefinition.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const decodeBot = Schema.decodeSync(Bot);
const decodeTeam = Schema.decodeSync(Team);
const decodePipeline = Schema.decodeSync(Pipeline);

const bot = (id: string, over: Record<string, unknown> = {}): Bot =>
  decodeBot({
    id,
    name: id,
    enabled: true,
    projectId: "project-1",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "replay", model: "echo" },
    approvalMode: "auto-safe",
    createdAt: NOW,
    updatedAt: NOW,
    soulBytes: 0,
    memoryBytes: 0,
    skills: [],
    threadTag: botThreadTag(BotId.make(id)),
    ...over,
  });

const team = (over: Record<string, unknown> = {}): Team =>
  decodeTeam({
    id: "build",
    name: "Build",
    leadBotId: "dev",
    memberBotIds: ["dev", "reviewer"],
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });

const stages = () => [
  { id: "dev", name: "Dev", botId: "dev", kind: "work" as const, instructions: "Implement it." },
  {
    id: "review",
    name: "Review",
    botId: "reviewer",
    kind: "review" as const,
    instructions: "Check it.",
    onFail: "dev",
  },
];

const pipeline = (over: Record<string, unknown> = {}): Pipeline =>
  decodePipeline({
    id: "ship",
    teamId: "build",
    name: "Ship",
    stages: stages(),
    limits: { maxRounds: 3, stageTimeoutMinutes: 60 },
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  });

interface FakeStores {
  readonly bots: Map<
    string,
    {
      bot: Bot;
      soul: string;
      memory: string;
      skills: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
      skillsDir: string;
    }
  >;
  readonly teams: Map<string, Team>;
  readonly pipelines: Map<string, Pipeline>;
}

const emptyStores = (): FakeStores => ({
  bots: new Map(),
  teams: new Map(),
  pipelines: new Map(),
});

/** The three stores the definition reads, over plain maps a test can change mid-run. */
const storeDeps = (stores: FakeStores): PipelineDefinitionDeps => ({
  bots: {
    find: (id: BotId) => Effect.succeed(stores.bots.get(id)?.bot),
    get: (id: BotId) => {
      const entry = stores.bots.get(id);
      return entry === undefined
        ? Effect.fail(new BotError({ message: "Bot not found." }))
        : Effect.succeed(entry);
    },
  } as unknown as BotStore["Service"],
  teams: {
    find: (id: Team["id"]) => Effect.succeed(stores.teams.get(id)),
  } as unknown as TeamStore["Service"],
  pipelines: {
    find: (id: Pipeline["id"]) => Effect.succeed(stores.pipelines.get(id)),
  } as unknown as PipelineStore["Service"],
});

type Started = Parameters<WorkflowAgents["Service"]["start"]>[0];

/** Agents the test plays: it sees each turn start and decides how that turn ends. */
const fakeAgents = () => {
  const turns = new Map<
    string,
    { started: Deferred.Deferred<Started>; ended: Deferred.Deferred<AgentResult> }
  >();
  let threads = 0;
  const turn = (key: string) => {
    const known = turns.get(key);
    if (known !== undefined) return known;
    const made = {
      started: Deferred.makeUnsafe<Started>(),
      ended: Deferred.makeUnsafe<AgentResult>(),
    };
    turns.set(key, made);
    return made;
  };
  return {
    service: WorkflowAgents.of({
      start: (input) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(turn(input.key).started, input);
          return {
            threadId: input.thread ?? `thread-${++threads}`,
            turnId: input.key,
            ...(input.environment === undefined ? {} : { environment: input.environment }),
          };
        }),
      result: (started) => Deferred.await(turn(started.turnId).ended),
      interrupt: () => Effect.succeed("stopped" as const),
    }),
    /** The turn of `runId` with this key, once it has been started. */
    started: (runId: string, key: string) => Deferred.await(turn(`${runId}/${key}`).started),
    end: (runId: string, key: string, result: Partial<AgentResult>) =>
      Deferred.succeed(turn(`${runId}/${key}`).ended, {
        ending: "completed" as const,
        detail: "",
        reply: "",
        ...result,
      }),
  };
};

/** The standard setup: dev builds, reviewer checks, and a fail goes back to dev. */
const seed = (stores: FakeStores, over: Record<string, unknown> = {}) => {
  stores.bots.set("dev", {
    bot: bot("dev", { name: "Dev", role: "Coder" }),
    soul: "You write code.",
    memory: "",
    skills: [],
    skillsDir: "/bots/dev/skills",
  });
  stores.bots.set("reviewer", {
    bot: bot("reviewer", { name: "Reviewer" }),
    soul: "You check work.",
    memory: "",
    skills: [],
    skillsDir: "/bots/reviewer/skills",
  });
  stores.teams.set("build", team());
  stores.pipelines.set("ship", pipeline(over));
};

const harness = Effect.fnUntraced(function* (stores: FakeStores) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pipeline-" });
  const database = NodeSqliteClient.layer({ filename: path.join(directory, "state.sqlite") });
  yield* Effect.provide(WorkflowsMigration, database);
  const agents = fakeAgents();
  const engine = WorkflowEngine.layer([makePipelineDefinition(storeDeps(stores))]).pipe(
    Layer.provide(Layer.succeed(WorkflowAgents, agents.service)),
    Layer.provide(database),
    Layer.provide(NodeCrypto.layer),
  );
  const clock = yield* Latch.make(true);
  const boot = <A, E>(use: Effect.Effect<A, E, Workflows.Workflows>) =>
    Effect.raceFirst(
      Effect.scoped(Effect.provide(use, engine)),
      Effect.forever(Effect.andThen(clock.await, TestClock.adjust("1 second"))),
    );
  return { agents, boot };
});

const status = (wanted: WorkflowRunStatus) => (run: { readonly status: string }) =>
  run.status === wanted;

const startRun = (
  workflows: Workflows.Workflows["Service"],
  over: { readonly task?: string; readonly key?: string; readonly ceiling?: RuntimeMode } = {},
) =>
  workflows.start(
    PIPELINE_WORKFLOW_NAME,
    {
      pipelineId: "ship",
      task: over.task ?? "Add a health endpoint.",
      projectId: "project-1",
      ...(over.ceiling === undefined ? {} : { runtimeCeiling: over.ceiling }),
    },
    { idempotencyKey: over.key ?? "run-1" },
  );

const workBrief = (round: number, extra: string = "") =>
  `Pipeline "Ship", stage "Dev" (round ${round} of 3).\n` +
  `Task: Add a health endpoint.\n` +
  `Your part: Implement it.\n` +
  extra +
  `When you are done, submit your result.`;

const reviewBrief = (round: number, summary: string) =>
  `Pipeline "Ship", stage "Review" (round ${round} of 3).\n` +
  `Task: Add a health endpoint.\n` +
  `Your part: Check it.\n` +
  `Work from earlier stages:\n` +
  `- Dev: ${summary}\n` +
  `Check the work against the task. Submit verdict "pass" only if it is done and correct; otherwise "fail" with each concrete problem as one finding.`;

it.effect("a pipeline that reviews clean passes on the first round", () =>
  Effect.gen(function* () {
    const stores = emptyStores();
    seed(stores);
    // dev keeps the default (confined); reviewer is not.
    stores.bots.get("reviewer")!.bot = bot("reviewer", {
      name: "Reviewer",
      stayInProject: false,
    });
    const { agents, boot } = yield* harness(stores);
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const { runId } = yield* startRun(workflows);

        const dev = yield* agents.started(runId, "dev@1/0");
        assert.equal(dev.thread, undefined);
        assert.equal(dev.title, "Dev: Dev");
        assert.equal(dev.project, "project-1");
        assert.deepStrictEqual(dev.tags, ["bot:dev"]);
        assert.equal(dev.launch?.workspaceConfined, true);
        assert.equal(dev.model?.instanceId, "replay");
        assert.equal(dev.model?.model, "echo");
        assert.equal(dev.launch?.runtimeMode, "auto");
        assert.equal(dev.launch?.interactionMode, "default");
        assert.deepStrictEqual(dev.outputSchema?.required, ["summary"]);
        // The lead's team section is in its standing instructions; the brief ends the prompt.
        assert.include(dev.prompt, "## Your team: Build");
        assert.include(dev.prompt, "- Reviewer (reviewer): no role");
        assert.isTrue(
          dev.prompt.endsWith(workBrief(1)),
          `prompt ended differently:\n${dev.prompt}`,
        );
        yield* agents.end(runId, "dev@1/0", { output: { summary: "Added the endpoint." } });

        const review = yield* agents.started(runId, "review@1/0");
        assert.equal(review.thread, undefined);
        assert.equal(review.title, "Reviewer: Review");
        assert.deepStrictEqual(review.tags, ["bot:reviewer"]);
        assert.equal(review.launch?.workspaceConfined, false);
        assert.deepStrictEqual(review.outputSchema?.required, ["verdict", "findings"]);
        assert.isTrue(review.prompt.endsWith(reviewBrief(1, "Added the endpoint.")));
        yield* agents.end(runId, "review@1/0", {
          output: { verdict: "pass", findings: [] },
        });

        const done = yield* workflows.waitFor(runId, status("completed"));
        assert.deepStrictEqual(done.result, {
          status: "passed",
          rounds: 1,
          summary: "Added the endpoint.",
        });
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a failed review goes back to its stage's thread, which then passes", () =>
  Effect.gen(function* () {
    const stores = emptyStores();
    seed(stores);
    const { agents, boot } = yield* harness(stores);
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const { runId } = yield* startRun(workflows);

        yield* agents.started(runId, "dev@1/0");
        yield* agents.end(runId, "dev@1/0", { output: { summary: "Added the endpoint." } });
        yield* agents.started(runId, "review@1/0");
        yield* agents.end(runId, "review@1/0", {
          output: { verdict: "fail", findings: ["Missing a test."] },
        });

        // Round two asks the same threads again, carrying the reviewer's findings. The
        // continued thread keeps its bot's standing instructions, so it gets the bare brief.
        const again = yield* agents.started(runId, "dev@2/0");
        assert.equal(again.thread, "thread-1");
        assert.isTrue(
          again.prompt.startsWith('Pipeline "'),
          `prompt started differently:\n${again.prompt}`,
        );
        assert.notInclude(again.prompt, "standing instructions");
        assert.equal(
          again.prompt,
          workBrief(
            2,
            `Work from earlier stages:\n- Dev: Added the endpoint.\n` +
              `Reviewer findings to fix:\n- Missing a test.\n`,
          ),
        );
        yield* agents.end(runId, "dev@2/0", { output: { summary: "Added the test." } });

        const reReview = yield* agents.started(runId, "review@2/0");
        assert.equal(reReview.thread, "thread-2");
        assert.equal(reReview.prompt, reviewBrief(2, "Added the test."));
        yield* agents.end(runId, "review@2/0", {
          output: { verdict: "pass", findings: [] },
        });

        const done = yield* workflows.waitFor(runId, status("completed"));
        assert.deepStrictEqual(done.result, {
          status: "passed",
          rounds: 2,
          summary: "Added the test.",
        });
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("past maxRounds the run asks, and goes on or stops by the answer", () =>
  Effect.gen(function* () {
    const stores = emptyStores();
    seed(stores, { limits: { maxRounds: 1, stageTimeoutMinutes: 60 } });
    const { agents, boot } = yield* harness(stores);
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const { runId } = yield* startRun(workflows);

        yield* agents.started(runId, "dev@1/0");
        yield* agents.end(runId, "dev@1/0", {
          output: { summary: "Added the endpoint." },
        });
        yield* agents.started(runId, "review@1/0");
        yield* agents.end(runId, "review@1/0", {
          output: { verdict: "fail", findings: ["Missing a test."] },
        });

        yield* workflows.waitFor(runId, (run) => run.detail === "limit-2");
        const [limit] = yield* workflows.questions;
        assert.equal(limit?.name, "limit-2");
        assert.deepStrictEqual(limit?.request, {
          title: "Ship: review still failing after 1 rounds. Last findings: Missing a test.",
          choices: ["One more round", "Stop"],
          data: { findings: ["Missing a test."] },
        });
        yield* workflows.answer(runId, "limit-2", { choice: "One more round" });

        const again = yield* agents.started(runId, "dev@2/0");
        assert.include(again.prompt, "round 2 of 1");
        yield* agents.end(runId, "dev@2/0", { output: { summary: "Tried again." } });
        yield* agents.end(runId, "review@2/0", {
          output: { verdict: "fail", findings: ["Still missing."] },
        });

        yield* workflows.waitFor(runId, (run) => run.detail === "limit-3");
        yield* workflows.answer(runId, "limit-3", { choice: "Stop" });
        const stopped = yield* workflows.waitFor(runId, status("stopped"));
        assert.equal(stopped.detail, "stopped by you after 2 rounds");
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a review that repeats its findings asks instead of looping again", () =>
  Effect.gen(function* () {
    const stores = emptyStores();
    seed(stores);
    const { agents, boot } = yield* harness(stores);
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const { runId } = yield* startRun(workflows);

        yield* agents.end(runId, "dev@1/0", { output: { summary: "Did it." } });
        yield* agents.end(runId, "review@1/0", {
          output: { verdict: "fail", findings: ["Missing a test.", " No docs. "] },
        });
        yield* agents.end(runId, "dev@2/0", { output: { summary: "Tried." } });
        yield* agents.end(runId, "review@2/0", {
          // The same findings, reordered and spaced: it is the same failure.
          output: { verdict: "fail", findings: ["no docs.", "missing a test."] },
        });

        yield* workflows.waitFor(runId, (run) => run.detail === "repeat-3");
        const [repeat] = yield* workflows.questions;
        assert.ok(repeat);
        assert.equal(repeat.name, "repeat-3");
        assert.deepStrictEqual((repeat.request as { choices: unknown }).choices, [
          "One more round",
          "Stop",
        ]);
        assert.equal(
          (repeat.request as { title: string }).title,
          "Ship: the reviewer repeated the same findings.",
        );
        yield* workflows.answer(runId, "repeat-3", { choice: "Stop" });
        const stopped = yield* workflows.waitFor(runId, status("stopped"));
        assert.equal(stopped.detail, "stopped by you after 2 rounds");
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a run keeps the bots it snapshotted, however the bots are then edited", () =>
  Effect.gen(function* () {
    const stores = emptyStores();
    seed(stores);
    const { agents, boot } = yield* harness(stores);
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const { runId } = yield* startRun(workflows);

        // `started` means the snapshot step ran: the bot is frozen from here on.
        yield* agents.started(runId, "dev@1/0");
        yield* agents.end(runId, "dev@1/0", { output: { summary: "Did it." } });
        // The bot is deleted mid-run; a live re-read would die at the snapshot check.
        stores.bots.delete("dev");
        yield* agents.end(runId, "review@1/0", {
          output: { verdict: "fail", findings: ["Missing a test."] },
        });
        const again = yield* agents.started(runId, "dev@2/0");
        assert.equal(
          again.prompt,
          workBrief(
            2,
            `Work from earlier stages:\n- Dev: Did it.\n` +
              `Reviewer findings to fix:\n- Missing a test.\n`,
          ),
        );
        yield* agents.end(runId, "dev@2/0", { output: { summary: "Tried." } });
        yield* agents.end(runId, "review@2/0", {
          output: { verdict: "pass", findings: [] },
        });
        const done = yield* workflows.waitFor(runId, status("completed"));
        assert.deepStrictEqual(done.result, {
          status: "passed",
          rounds: 2,
          summary: "Tried.",
        });
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a runtime ceiling narrows every stage thread's mode", () =>
  Effect.gen(function* () {
    const stores = emptyStores();
    seed(stores);
    stores.bots.set("dev", {
      bot: bot("dev", { name: "Dev", role: "Coder", approvalMode: "full" }),
      soul: "You write code.",
      memory: "",
      skills: [],
      skillsDir: "/bots/dev/skills",
    });
    const { agents, boot } = yield* harness(stores);
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const { runId } = yield* startRun(workflows, { ceiling: "approval-required" });

        // The dev bot is full-access, but the caller's ceiling keeps it at approval-required.
        const dev = yield* agents.started(runId, "dev@1/0");
        assert.equal(dev.launch?.runtimeMode, "approval-required");
        yield* agents.end(runId, "dev@1/0", { output: { summary: "Added the endpoint." } });

        // An auto-safe bot narrows the same way.
        const review = yield* agents.started(runId, "review@1/0");
        assert.equal(review.launch?.runtimeMode, "approval-required");
        yield* agents.end(runId, "review@1/0", {
          output: { verdict: "pass", findings: [] },
        });
        yield* workflows.waitFor(runId, status("completed"));
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect("a stage thread that dies pauses its run until a person resumes it", () =>
  Effect.gen(function* () {
    const stores = emptyStores();
    seed(stores);
    const { agents, boot } = yield* harness(stores);
    yield* boot(
      Effect.gen(function* () {
        const workflows = yield* Workflows.Workflows;
        const { runId } = yield* startRun(workflows);

        yield* agents.started(runId, "dev@1/0");
        yield* agents.end(runId, "dev@1/0", { ending: "failed", detail: "the agent died" });
        const restarted = yield* agents.started(runId, "dev@1/1");
        assert.equal(restarted.thread, undefined);
        yield* agents.end(runId, "dev@1/1", { ending: "failed", detail: "died again" });
        const paused = yield* workflows.waitFor(runId, status("paused"));
        assert.include(paused.detail ?? "", "died again");
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
