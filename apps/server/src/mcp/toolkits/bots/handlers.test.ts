import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  Bot,
  BotError,
  BotId,
  BotSkillName,
  botThreadTag,
  EnvironmentId,
  NodeId,
  Pipeline,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ServerProvider,
  Team,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestratorMcpDelegateTaskResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import { BotService } from "../../../bots/BotService.ts";
import { BotStore } from "../../../bots/BotStore.ts";
import { PipelineService } from "../../../bots/PipelineService.ts";
import { TeamService } from "../../../bots/TeamService.ts";
import { TeamStore } from "../../../bots/TeamStore.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as BotsHandlers from "./handlers.ts";
import { BotsToolkit } from "./tools.ts";

const decodeBot = Schema.decodeUnknownSync(Bot);
const decodeTeam = Schema.decodeUnknownSync(Team);
const decodePipeline = Schema.decodeUnknownSync(Pipeline);

const plannerBot = (overrides?: Record<string, unknown>): Bot =>
  decodeBot({
    id: "planner",
    name: "Planner",
    role: "Plans work",
    enabled: true,
    projectId: "project-1",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "claude", model: "claude-opus-4-6" },
    approvalMode: "full",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    soulBytes: 4,
    threadTag: "bot:planner",
    ...overrides,
  });

const buildTeam = (overrides?: Record<string, unknown>): Team =>
  decodeTeam({
    id: "build",
    name: "Build",
    leadBotId: "planner",
    memberBotIds: ["planner", "dev"],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

const shipStages = () => [
  { id: "dev", name: "Dev", botId: "dev", kind: "work" as const, instructions: "Do it." },
  {
    id: "review",
    name: "Review",
    botId: "planner",
    kind: "review" as const,
    instructions: "Check it.",
    onFail: "dev",
  },
];

const shipPipeline = (overrides?: Record<string, unknown>): Pipeline =>
  decodePipeline({
    id: "ship",
    teamId: "build",
    name: "Ship",
    stages: shipStages(),
    limits: { maxRounds: 3, stageTimeoutMinutes: 60 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

const threadId = ThreadId.make("mcp-bots-thread");
const childThreadId = ThreadId.make("mcp-bots-child");

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("mcp-bots-environment"),
  requestNamespace: "mcp-bots-session",
  thread: {
    threadId,
    providerSessionId: "mcp-bots-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-bots", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-bots", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const delegateResult: OrchestratorMcpDelegateTaskResult = {
  taskId: NodeId.make("task-1"),
  childThreadId,
  childRunId: RunId.make("run:child"),
  childNodeId: NodeId.make("node-1"),
  status: "running",
  workState: "working",
  hasPendingChildRuns: false,
  latestTerminalRunId: null,
  latestTerminalStatus: null,
  latestTerminalSummary: null,
  latestTerminalResultContextTransferId: null,
  providerInstanceId: ProviderInstanceId.make("claude"),
  model: "claude-opus-4-6",
  summary: null,
  resultContextTransferId: null,
  hasPendingQuestion: false,
  pendingApproval: null,
  waitTimedOut: false,
};

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

const layerToolkit = (input: {
  readonly bots: ReadonlyArray<Bot>;
  readonly souls?: ReadonlyMap<BotId, string>;
  readonly memories?: ReadonlyMap<BotId, string>;
  readonly callerTags?: ReadonlyArray<string>;
  readonly callerRuntimeMode?: "approval-required" | "auto" | "full-access";
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly teams?: ReadonlyArray<Team>;
  readonly pipelines?: ReadonlyArray<Pipeline>;
}) => {
  const calls: Array<unknown> = [];
  const storedMemories = new Map(input.memories ?? []);
  const layerStore = Layer.mock(BotStore)({
    list: () => Effect.succeed({ bots: [...input.bots], loadErrors: [] }),
    find: (id) => Effect.succeed(input.bots.find((entry) => entry.id === id)),
    get: (id) => {
      const bot = input.bots.find((entry) => entry.id === id);
      return bot === undefined
        ? Effect.fail(new BotError({ message: "Bot not found.", botId: id }))
        : Effect.succeed({
            bot,
            soul: input.souls?.get(id) ?? "",
            memory: storedMemories.get(id) ?? "",
            skills: [],
            skillsDir: `/bots/${id}/skills`,
          });
    },
    writeMemory: (id, memory) => {
      const bot = input.bots.find((entry) => entry.id === id);
      if (bot === undefined) {
        return Effect.fail(new BotError({ message: "Bot not found.", botId: id }));
      }
      storedMemories.set(id, memory);
      return Effect.succeed(Buffer.byteLength(memory, "utf8"));
    },
  });
  const layerBotService = Layer.mock(BotService)({
    get: ({ id }) => {
      const bot = input.bots.find((entry) => entry.id === id);
      return bot === undefined
        ? Effect.fail(new BotError({ message: "Bot not found.", botId: id }))
        : Effect.succeed({
            bot,
            soul: input.souls?.get(id) ?? "",
            memory: storedMemories.get(id) ?? "",
          });
    },
    upsert: (upsertInput) => {
      calls.push({ type: "upsert", input: upsertInput });
      const id = upsertInput.id ?? BotId.make("created-bot");
      return Effect.succeed({
        bot: decodeBot({
          ...upsertInput,
          id,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          soulBytes: 0,
          threadTag: botThreadTag(id),
        }),
      });
    },
    installSkill: ({ id }) => {
      calls.push({ type: "installSkill", botId: id });
      const bot = input.bots.find((entry) => entry.id === id);
      return bot === undefined
        ? Effect.fail(new BotError({ message: "Bot not found.", botId: id }))
        : Effect.succeed({
            bot: { ...bot, skills: [{ name: BotSkillName.make("installed-skill") }] },
          });
    },
  });
  const layerTeamService = Layer.mock(TeamService)({
    list: () => Effect.succeed({ teams: [...(input.teams ?? [])], loadErrors: [] }),
    upsert: (upsertInput) => {
      calls.push({ type: "teamUpsert", input: upsertInput });
      return Effect.succeed({
        team: decodeTeam({
          id: upsertInput.id ?? "new-team",
          name: upsertInput.name,
          memberBotIds: upsertInput.memberBotIds,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          ...(upsertInput.description === undefined
            ? {}
            : { description: upsertInput.description }),
          ...(upsertInput.leadBotId === undefined ? {} : { leadBotId: upsertInput.leadBotId }),
        }),
      });
    },
  });
  const layerPipelineService = Layer.mock(PipelineService)({
    list: () => Effect.succeed({ pipelines: [...(input.pipelines ?? [])], loadErrors: [] }),
    upsert: (upsertInput) => {
      calls.push({ type: "pipelineUpsert", input: upsertInput });
      // Enough of the real service's check to prove its errors surface.
      for (const stage of upsertInput.stages) {
        if (
          stage.onFail !== undefined &&
          !upsertInput.stages.some((candidate) => candidate.id === stage.onFail)
        ) {
          return Effect.fail(
            new BotError({
              message: `Stage "${stage.name}" goes back to "${stage.onFail}", which is not a stage of this pipeline.`,
            }),
          );
        }
      }
      return Effect.succeed({
        pipeline: decodePipeline({
          id: upsertInput.id ?? "new-pipeline",
          teamId: upsertInput.teamId,
          name: upsertInput.name,
          stages: upsertInput.stages,
          limits: upsertInput.limits ?? { maxRounds: 3, stageTimeoutMinutes: 60 },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          ...(upsertInput.description === undefined
            ? {}
            : { description: upsertInput.description }),
        }),
      });
    },
    run: (runInput) => {
      calls.push({ type: "pipelineRun", input: runInput });
      return Effect.succeed({ runId: "run-9" });
    },
  });
  const layerProviders = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Effect.succeed(input.providers ?? []),
  });
  const layerService = Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
    delegateTask: (callScope, callInput) => {
      calls.push({ scope: callScope, input: callInput });
      return Effect.succeed(delegateResult);
    },
  });
  const layerOrchestrator = Layer.mock(Orchestrator.OrchestratorV2)({
    dispatch: (command: OrchestrationV2ServerCommand) => {
      calls.push(command);
      return Effect.succeed({ sequence: 1, storedEvents: [] });
    },
  });
  const layerThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) =>
      Effect.succeed({
        ...McpToolAccessTestkit.liveThreadShell(id, {
          runtimeMode: input.callerRuntimeMode ?? "full-access",
        }),
        ...(input.callerTags === undefined ? {} : { tags: [...input.callerTags] }),
      }),
  });
  return {
    calls,
    layer: McpHttpServer.toolkitRegistration(BotsToolkit, BotsHandlers.layer).pipe(
      Layer.provide(layerStore),
      Layer.provide(
        Layer.mock(TeamStore)({
          list: () => Effect.succeed({ teams: [], loadErrors: [] }),
        }),
      ),
      Layer.provide(layerBotService),
      Layer.provide(layerTeamService),
      Layer.provide(layerPipelineService),
      Layer.provide(layerProviders),
      Layer.provide(layerService),
      Layer.provide(layerOrchestrator),
      Layer.provide(layerThreads),
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provide(NodeCrypto.layer),
    ),
  };
};

const callTool = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("list_bots returns only enabled bots and the caller's bot tag", () => {
  const { layer } = layerToolkit({
    bots: [plannerBot(), plannerBot({ id: "off-duty", name: "Off Duty", enabled: false })],
    callerTags: [botThreadTag(BotId.make("chief"))],
  });
  return Effect.gen(function* () {
    const result = yield* callTool("list_bots", {});
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      selfBotId: "chief",
      bots: [
        {
          id: "planner",
          name: "Planner",
          providerInstanceId: "claude",
          model: "claude-opus-4-6",
          approvalMode: "full",
        },
      ],
    });
  }).pipe(Effect.provide(layer));
});

it.effect("list_bots reports a null selfBotId outside a bot thread", () => {
  const { layer } = layerToolkit({ bots: [plannerBot()] });
  return Effect.gen(function* () {
    const result = yield* callTool("list_bots", {});
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ selfBotId: null });
    expect((result.structuredContent as { bots: Array<unknown> }).bots).toHaveLength(1);
  }).pipe(Effect.provide(layer));
});

it.effect("delegate_to_bot fails for a missing, disabled, or self bot", () =>
  Effect.gen(function* () {
    const { layer: missing } = layerToolkit({ bots: [] });
    expect(
      declaredFailure(
        yield* callTool("delegate_to_bot", { botId: "ghost", task: "hi" }).pipe(
          Effect.provide(missing),
        ),
      ),
    ).toMatchObject({ code: "invalid_request", message: "Bot not found." });

    const { layer: disabled } = layerToolkit({
      bots: [plannerBot({ enabled: false })],
    });
    expect(
      declaredFailure(
        yield* callTool("delegate_to_bot", { botId: "planner", task: "hi" }).pipe(
          Effect.provide(disabled),
        ),
      ),
    ).toMatchObject({ code: "invalid_request", message: "Bot is disabled." });

    const { layer: self } = layerToolkit({
      bots: [plannerBot()],
      callerTags: [botThreadTag(BotId.make("planner"))],
    });
    expect(
      declaredFailure(
        yield* callTool("delegate_to_bot", { botId: "planner", task: "hi" }).pipe(
          Effect.provide(self),
        ),
      ),
    ).toMatchObject({ code: "invalid_request", message: "A bot cannot delegate to itself." });
  }),
);

it.effect("delegate_to_bot hands the built input to delegateTask and tags the child thread", () => {
  const { calls, layer } = layerToolkit({
    bots: [plannerBot()],
    souls: new Map([[BotId.make("planner"), "Keep plans short."]]),
    callerRuntimeMode: "approval-required",
  });
  return Effect.gen(function* () {
    const result = yield* callTool("delegate_to_bot", {
      botId: "planner",
      task: "Sketch the rollout",
    });
    expect(result.isError).not.toBe(true);

    const delegation = calls.find(
      (call): call is { scope: unknown; input: Record<string, unknown> } =>
        typeof call === "object" && call !== null && "input" in call,
    );
    expect(delegation?.input).toMatchObject({
      target: { providerInstanceId: "claude", model: "claude-opus-4-6" },
      runtimeMode: "approval-required",
      role: "general",
      title: "Planner: Sketch the rollout",
    });
    expect(delegation?.input.task).toContain("Keep plans short.");

    const tag = calls.find(
      (call): call is OrchestrationV2ServerCommand =>
        typeof call === "object" && call !== null && "type" in call,
    );
    expect(tag).toMatchObject({
      type: "thread.tag.set",
      threadId: childThreadId,
      tag: "bot:planner",
      tagged: true,
    });

    expect(result.structuredContent).toMatchObject({ botId: "planner", taskId: "task-1" });
  }).pipe(Effect.provide(layer));
});

it.effect("update_bot_memory appends to an empty memory", () => {
  const { layer } = layerToolkit({
    bots: [plannerBot()],
    callerTags: [botThreadTag(BotId.make("planner"))],
  });
  return Effect.gen(function* () {
    const result = yield* callTool("update_bot_memory", {
      mode: "append",
      text: "Prefers short plans.",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      botId: "planner",
      memoryBytes: Buffer.byteLength("Prefers short plans.", "utf8"),
    });
  }).pipe(Effect.provide(layer));
});

it.effect("update_bot_memory joins an existing memory with a blank line", () => {
  const { layer } = layerToolkit({
    bots: [plannerBot()],
    memories: new Map([[BotId.make("planner"), "Prefers short plans."]]),
    callerTags: [botThreadTag(BotId.make("planner"))],
  });
  return Effect.gen(function* () {
    const result = yield* callTool("update_bot_memory", {
      mode: "append",
      text: "Ships Friday.",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      memoryBytes: Buffer.byteLength("Prefers short plans.\n\nShips Friday.", "utf8"),
    });
  }).pipe(Effect.provide(layer));
});

it.effect("update_bot_memory replaces the whole memory", () => {
  const { layer } = layerToolkit({
    bots: [plannerBot()],
    memories: new Map([[BotId.make("planner"), "Stale notes. ".repeat(300)]]),
    callerTags: [botThreadTag(BotId.make("planner"))],
  });
  return Effect.gen(function* () {
    const result = yield* callTool("update_bot_memory", {
      mode: "replace",
      text: "Only Friday.",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      botId: "planner",
      memoryBytes: Buffer.byteLength("Only Friday.", "utf8"),
    });
  }).pipe(Effect.provide(layer));
});

it.effect("update_bot_memory refuses when the result would exceed the cap", () => {
  const { layer } = layerToolkit({
    bots: [plannerBot()],
    memories: new Map([[BotId.make("planner"), "x".repeat(15_900)]]),
    callerTags: [botThreadTag(BotId.make("planner"))],
  });
  return Effect.gen(function* () {
    const failure = declaredFailure(
      yield* callTool("update_bot_memory", { mode: "append", text: "y".repeat(200) }),
    );
    expect(failure).toMatchObject({ code: "invalid_request" });
    expect(failure?.message).toContain("replace");
  }).pipe(Effect.provide(layer));
});

it.effect("update_bot_memory refuses a caller that is not running as a bot", () => {
  const { layer } = layerToolkit({ bots: [plannerBot()] });
  return Effect.gen(function* () {
    const failure = declaredFailure(
      yield* callTool("update_bot_memory", { mode: "append", text: "hi" }),
    );
    expect(failure).toMatchObject({
      code: "invalid_request",
      message: "update_bot_memory only works in a bot's own thread.",
    });
  }).pipe(Effect.provide(layer));
});

const NOT_A_MANAGER =
  'This bot isn\'t allowed to manage bots. Turn on "Can create and edit other bots" in its profile.';

const managerBot = (overrides?: Record<string, unknown>): Bot =>
  plannerBot({ id: "manager", name: "Manager", canManageBots: true, ...overrides });

const managerCaller = { callerTags: [botThreadTag(BotId.make("manager"))] };

it.effect("the bot-management tools refuse a caller that is not a bot thread", () => {
  const { layer } = layerToolkit({ bots: [managerBot()] });
  return Effect.gen(function* () {
    for (const [name, args] of [
      ["get_bot", { botId: "manager" }],
      ["create_bot", { name: "Worker", soul: "Do work." }],
      ["update_bot", { botId: "manager", name: "Renamed" }],
      ["install_bot_skill", { botId: "manager", sourcePath: "/skills/a" }],
      ["list_teams", {}],
      ["save_team", { name: "Docs", memberBotIds: ["manager"] }],
      ["save_pipeline", { teamId: "build", name: "Ship", stages: shipStages() }],
      ["run_pipeline", { pipelineId: "ship", task: "Do it." }],
    ] as const) {
      expect(declaredFailure(yield* callTool(name, args))).toMatchObject({
        code: "invalid_request",
        message: NOT_A_MANAGER,
      });
    }
  }).pipe(Effect.provide(layer));
});

it.effect("the bot-management tools refuse a bot without canManageBots", () => {
  const { layer } = layerToolkit({
    bots: [plannerBot()],
    callerTags: [botThreadTag(BotId.make("planner"))],
  });
  return Effect.gen(function* () {
    expect(
      declaredFailure(yield* callTool("create_bot", { name: "Worker", soul: "Do work." })),
    ).toMatchObject({ code: "invalid_request", message: NOT_A_MANAGER });
    expect(declaredFailure(yield* callTool("get_bot", { botId: "planner" }))).toMatchObject({
      code: "invalid_request",
      message: NOT_A_MANAGER,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("get_bot returns the full profile with the soul", () => {
  const { layer } = layerToolkit({
    bots: [
      managerBot(),
      plannerBot({
        id: "worker",
        name: "Worker",
        avatar: { shape: "hexagon", color: "#00d47e" },
        interactionMode: "plan",
        skills: [{ name: "review-code", description: "Reviews code." }],
      }),
    ],
    souls: new Map([[BotId.make("worker"), "Stand tall."]]),
    ...managerCaller,
  });
  return Effect.gen(function* () {
    const result = yield* callTool("get_bot", { botId: "worker" });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      bot: {
        id: "worker",
        name: "Worker",
        role: "Plans work",
        providerInstanceId: "claude",
        model: "claude-opus-4-6",
        approvalMode: "full",
        avatar: { shape: "hexagon", color: "#00d47e" },
        interactionMode: "plan",
        canManageBots: false,
        skills: [{ name: "review-code", description: "Reviews code." }],
        soul: "Stand tall.",
        memoryBytes: 0,
      },
    });
  }).pipe(Effect.provide(layer));
});

it.effect("create_bot inherits the caller's project, model and approval mode", () => {
  const { calls, layer } = layerToolkit({
    bots: [managerBot({ approvalMode: "auto-safe" })],
    providers: [devinProvider],
    ...managerCaller,
  });
  return Effect.gen(function* () {
    const result = yield* callTool("create_bot", {
      name: "Worker",
      soul: "Do work.",
      role: "Works",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ botId: "created-bot" });
    const upsert = calls.find(
      (call): call is { type: "upsert"; input: Record<string, unknown> } =>
        typeof call === "object" && call !== null && "type" in call && call.type === "upsert",
    );
    expect(upsert?.input).toMatchObject({
      name: "Worker",
      enabled: true,
      projectId: "project-1",
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "claude", model: "claude-opus-4-6" },
      approvalMode: "auto-safe",
      soul: "Do work.",
      role: "Works",
      canManageBots: false,
    });
  }).pipe(Effect.provide(layer));
});

it.effect("create_bot takes a listed model pick and refuses an unknown one", () => {
  const { calls, layer } = layerToolkit({
    bots: [managerBot()],
    providers: [devinProvider],
    ...managerCaller,
  });
  return Effect.gen(function* () {
    const picked = yield* callTool("create_bot", {
      name: "Worker",
      soul: "Do work.",
      model: { providerInstanceId: "devin", model: "swe-1.6" },
    });
    expect(picked.isError).not.toBe(true);
    const upsert = calls.find(
      (call): call is { type: "upsert"; input: Record<string, unknown> } =>
        typeof call === "object" && call !== null && "type" in call && call.type === "upsert",
    );
    expect(upsert?.input).toMatchObject({
      modelSelection: { instanceId: "devin", model: "swe-1.6" },
    });

    const failure = declaredFailure(
      yield* callTool("create_bot", {
        name: "Worker",
        soul: "Do work.",
        model: { providerInstanceId: "devin", model: "ghost" },
      }),
    );
    expect(failure).toMatchObject({
      code: "invalid_request",
      message:
        'Model "ghost" is not available on provider "devin". Available provider instances: devin.',
    });
  }).pipe(Effect.provide(layer));
});

it.effect("create_bot refuses an approval mode above the caller's", () => {
  const { layer } = layerToolkit({
    bots: [managerBot({ approvalMode: "auto-safe" })],
    ...managerCaller,
  });
  return Effect.gen(function* () {
    const failure = declaredFailure(
      yield* callTool("create_bot", {
        name: "Worker",
        soul: "Do work.",
        approvalMode: "full",
      }),
    );
    expect(failure).toMatchObject({
      code: "invalid_request",
      message: 'Approval mode "full" is above your own ("auto-safe").',
    });
  }).pipe(Effect.provide(layer));
});

it.effect("update_bot keeps the fields the call leaves out", () => {
  const { calls, layer } = layerToolkit({
    bots: [
      managerBot(),
      plannerBot({
        id: "worker",
        pinned: true,
        limits: { maxStepsPerRun: 5 },
        avatar: { shape: "hexagon", color: "#00d47e" },
        interactionMode: "plan",
        approvalMode: "ask",
        role: "Old role",
      }),
    ],
    ...managerCaller,
  });
  return Effect.gen(function* () {
    const result = yield* callTool("update_bot", {
      botId: "worker",
      name: "Renamed",
      soul: "New instructions.",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ botId: "worker" });
    const upsert = calls.find(
      (call): call is { type: "upsert"; input: Record<string, unknown> } =>
        typeof call === "object" && call !== null && "type" in call && call.type === "upsert",
    );
    expect(upsert?.input).toMatchObject({
      id: "worker",
      name: "Renamed",
      enabled: true,
      projectId: "project-1",
      modelSelection: { instanceId: "claude", model: "claude-opus-4-6" },
      approvalMode: "ask",
      interactionMode: "plan",
      limits: { maxStepsPerRun: 5 },
      pinned: true,
      canManageBots: false,
      avatar: { shape: "hexagon", color: "#00d47e" },
      role: "Old role",
      soul: "New instructions.",
    });
  }).pipe(Effect.provide(layer));
});

it.effect("update_bot refuses the caller itself, other managers, and approval raises", () =>
  Effect.gen(function* () {
    const { layer: self } = layerToolkit({
      bots: [managerBot()],
      ...managerCaller,
    });
    expect(
      declaredFailure(
        yield* callTool("update_bot", { botId: "manager", name: "Me" }).pipe(Effect.provide(self)),
      ),
    ).toMatchObject({ code: "invalid_request", message: "You can't edit yourself." });

    const { layer: managerTarget } = layerToolkit({
      bots: [managerBot(), managerBot({ id: "other-manager" })],
      ...managerCaller,
    });
    expect(
      declaredFailure(
        yield* callTool("update_bot", { botId: "other-manager", name: "X" }).pipe(
          Effect.provide(managerTarget),
        ),
      ),
    ).toMatchObject({
      code: "invalid_request",
      message: "You can't edit another bot that manages bots.",
    });

    const { layer: raise } = layerToolkit({
      bots: [
        managerBot({ approvalMode: "auto-safe" }),
        plannerBot({ id: "worker", approvalMode: "auto-safe" }),
      ],
      ...managerCaller,
    });
    expect(
      declaredFailure(
        yield* callTool("update_bot", { botId: "worker", approvalMode: "full" }).pipe(
          Effect.provide(raise),
        ),
      ),
    ).toMatchObject({
      code: "invalid_request",
      message: 'Approval mode "full" is above your own ("auto-safe").',
    });
  }),
);

it.effect("update_bot refuses a target above the caller's approval and leaves it unchanged", () => {
  const { calls, layer } = layerToolkit({
    bots: [
      managerBot({ approvalMode: "auto-safe" }),
      plannerBot({ id: "worker", approvalMode: "full" }),
    ],
    ...managerCaller,
  });
  return Effect.gen(function* () {
    const failure = declaredFailure(
      yield* callTool("update_bot", { botId: "worker", name: "Renamed", soul: "Hacked." }),
    );
    expect(failure).toMatchObject({
      code: "invalid_request",
      message:
        'You can\'t edit a bot whose approval mode ("full") is above your own ("auto-safe").',
    });
    expect(
      calls.filter(
        (call): call is { type: "upsert" } =>
          typeof call === "object" && call !== null && "type" in call && call.type === "upsert",
      ),
    ).toHaveLength(0);
  }).pipe(Effect.provide(layer));
});

it.effect("install_bot_skill works on self and editable targets, refuses managers", () =>
  Effect.gen(function* () {
    const { calls, layer } = layerToolkit({
      bots: [managerBot(), plannerBot({ id: "worker" })],
      ...managerCaller,
    });

    const selfResult = yield* callTool("install_bot_skill", {
      botId: "manager",
      sourcePath: "/skills/a",
    }).pipe(Effect.provide(layer));
    expect(selfResult.isError).not.toBe(true);
    expect(selfResult.structuredContent).toMatchObject({
      botId: "manager",
      skills: ["installed-skill"],
    });

    const targetResult = yield* callTool("install_bot_skill", {
      botId: "worker",
      sourcePath: "/skills/b",
    }).pipe(Effect.provide(layer));
    expect(targetResult.isError).not.toBe(true);
    expect(
      calls.filter(
        (call): call is { type: "installSkill" } =>
          typeof call === "object" &&
          call !== null &&
          "type" in call &&
          call.type === "installSkill",
      ),
    ).toHaveLength(2);

    const { layer: managerTarget } = layerToolkit({
      bots: [managerBot(), managerBot({ id: "other-manager" })],
      ...managerCaller,
    });
    expect(
      declaredFailure(
        yield* callTool("install_bot_skill", {
          botId: "other-manager",
          sourcePath: "/skills/c",
        }).pipe(Effect.provide(managerTarget)),
      ),
    ).toMatchObject({
      code: "invalid_request",
      message: "You can't edit another bot that manages bots.",
    });
  }),
);

it.effect("list_teams returns each team with its members and pipelines in stage order", () => {
  const { layer } = layerToolkit({
    bots: [
      managerBot(),
      plannerBot({ id: "planner" }),
      plannerBot({ id: "dev", name: "Dev", role: "Coder" }),
    ],
    teams: [buildTeam()],
    pipelines: [shipPipeline()],
    ...managerCaller,
  });
  return Effect.gen(function* () {
    const result = yield* callTool("list_teams", {});
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      teams: [
        {
          id: "build",
          name: "Build",
          leadBotId: "planner",
          members: [
            { id: "planner", name: "Planner", role: "Plans work" },
            { id: "dev", name: "Dev", role: "Coder" },
          ],
          pipelines: [
            {
              id: "ship",
              name: "Ship",
              stages: [
                { id: "dev", name: "Dev", botId: "dev", kind: "work" },
                {
                  id: "review",
                  name: "Review",
                  botId: "planner",
                  kind: "review",
                  onFail: "dev",
                },
              ],
              limits: { maxRounds: 3, stageTimeoutMinutes: 60 },
            },
          ],
        },
      ],
    });
  }).pipe(Effect.provide(layer));
});

it.effect("save_team creates a team, and a change keeps the fields it leaves out", () =>
  Effect.gen(function* () {
    const { calls, layer } = layerToolkit({
      bots: [managerBot(), plannerBot({ id: "dev", name: "Dev" })],
      ...managerCaller,
    });
    const created = yield* callTool("save_team", {
      name: "Docs",
      description: "Writes docs.",
      leadBotId: "manager",
      memberBotIds: ["manager", "dev"],
    }).pipe(Effect.provide(layer));
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({ teamId: "new-team" });
    const createUpsert = calls.find(
      (call): call is { type: "teamUpsert"; input: Record<string, unknown> } =>
        typeof call === "object" && call !== null && "type" in call && call.type === "teamUpsert",
    );
    expect(createUpsert?.input).toMatchObject({
      name: "Docs",
      description: "Writes docs.",
      leadBotId: "manager",
      memberBotIds: ["manager", "dev"],
    });

    const { calls: updateCalls, layer: updateLayer } = layerToolkit({
      bots: [managerBot(), plannerBot({ id: "dev", name: "Dev" })],
      teams: [buildTeam({ description: "Builds." })],
      ...managerCaller,
    });
    const updated = yield* callTool("save_team", { id: "build", name: "Build 2" }).pipe(
      Effect.provide(updateLayer),
    );
    expect(updated.isError).not.toBe(true);
    expect(updated.structuredContent).toMatchObject({ teamId: "build" });
    const updateUpsert = updateCalls.find(
      (call): call is { type: "teamUpsert"; input: Record<string, unknown> } =>
        typeof call === "object" && call !== null && "type" in call && call.type === "teamUpsert",
    );
    expect(updateUpsert?.input).toMatchObject({
      id: "build",
      name: "Build 2",
      description: "Builds.",
      leadBotId: "planner",
      memberBotIds: ["planner", "dev"],
    });
  }),
);

it.effect("save_team and save_pipeline say which fields a create is missing", () =>
  Effect.gen(function* () {
    const { layer } = layerToolkit({ bots: [managerBot()], ...managerCaller });
    expect(
      declaredFailure(
        yield* callTool("save_team", { description: "No members." }).pipe(Effect.provide(layer)),
      ),
    ).toMatchObject({
      code: "invalid_request",
      message: "Creating a team needs `name` and `memberBotIds`.",
    });
    expect(
      declaredFailure(yield* callTool("save_team", { name: "Docs" }).pipe(Effect.provide(layer))),
    ).toMatchObject({
      code: "invalid_request",
      message: "Creating a team needs `memberBotIds`.",
    });
    expect(
      declaredFailure(
        yield* callTool("save_pipeline", { name: "Ship" }).pipe(Effect.provide(layer)),
      ),
    ).toMatchObject({
      code: "invalid_request",
      message: "Creating a pipeline needs `teamId` and `stages`.",
    });
    expect(
      declaredFailure(
        yield* callTool("save_team", { id: "ghost", name: "Docs" }).pipe(Effect.provide(layer)),
      ),
    ).toMatchObject({
      code: "invalid_request",
      message: 'Team "ghost" was not found.',
    });
  }),
);

it.effect("save_pipeline surfaces the service's stage validation", () => {
  const { layer } = layerToolkit({ bots: [managerBot()], ...managerCaller });
  return Effect.gen(function* () {
    const failure = declaredFailure(
      yield* callTool("save_pipeline", {
        teamId: "build",
        name: "Ship",
        stages: [
          { id: "dev", name: "Dev", botId: "dev", kind: "work", instructions: "Do it." },
          {
            id: "check",
            name: "Check",
            botId: "manager",
            kind: "review",
            instructions: "Check it.",
            onFail: "ghost",
          },
        ],
      }),
    );
    expect(failure).toMatchObject({
      code: "invalid_request",
      message: 'Stage "Check" goes back to "ghost", which is not a stage of this pipeline.',
    });
  }).pipe(Effect.provide(layer));
});

it.effect("save_pipeline replaces the whole stage list on a change", () => {
  const next = [
    { id: "solo", name: "Solo", botId: "planner", kind: "work", instructions: "Do it all." },
  ];
  const { calls, layer } = layerToolkit({
    bots: [managerBot(), plannerBot({ id: "dev", name: "Dev" })],
    teams: [buildTeam()],
    pipelines: [shipPipeline({ description: "Ships." })],
    ...managerCaller,
  });
  return Effect.gen(function* () {
    const result = yield* callTool("save_pipeline", { id: "ship", stages: next });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ pipelineId: "ship" });
    const upsert = calls.find(
      (call): call is { type: "pipelineUpsert"; input: Record<string, unknown> } =>
        typeof call === "object" &&
        call !== null &&
        "type" in call &&
        call.type === "pipelineUpsert",
    );
    expect(upsert?.input).toMatchObject({
      id: "ship",
      teamId: "build",
      name: "Ship",
      description: "Ships.",
      limits: { maxRounds: 3, stageTimeoutMinutes: 60 },
      stages: [
        { id: "solo", name: "Solo", botId: "planner", kind: "work", instructions: "Do it all." },
      ],
    });
  }).pipe(Effect.provide(layer));
});

it.effect("run_pipeline starts the run in the caller's project under its runtime ceiling", () => {
  const { calls, layer } = layerToolkit({
    bots: [managerBot()],
    ...managerCaller,
    callerRuntimeMode: "approval-required",
  });
  return Effect.gen(function* () {
    const result = yield* callTool("run_pipeline", { pipelineId: "ship", task: "Do it." });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ runId: "run-9" });
    const run = calls.find(
      (call): call is { type: "pipelineRun"; input: Record<string, unknown> } =>
        typeof call === "object" && call !== null && "type" in call && call.type === "pipelineRun",
    );
    expect(run?.input).toMatchObject({
      pipelineId: "ship",
      task: "Do it.",
      projectId: "project:mcp-test",
      runtimeCeiling: "approval-required",
    });
    expect(run?.input.commandId).toMatch(/^mcp:/);
  }).pipe(Effect.provide(layer));
});

it.effect("run_pipeline takes an explicit project over the caller's", () => {
  const { calls, layer } = layerToolkit({
    bots: [managerBot()],
    ...managerCaller,
  });
  return Effect.gen(function* () {
    const result = yield* callTool("run_pipeline", {
      pipelineId: "ship",
      task: "Do it.",
      projectId: "project:other",
    });
    expect(result.isError).not.toBe(true);
    const run = calls.find(
      (call): call is { type: "pipelineRun"; input: Record<string, unknown> } =>
        typeof call === "object" && call !== null && "type" in call && call.type === "pipelineRun",
    );
    expect(run?.input).toMatchObject({ projectId: "project:other" });
  }).pipe(Effect.provide(layer));
});

it.effect("save_team and save_pipeline refuse a bot above the caller's approval", () =>
  Effect.gen(function* () {
    const autoSafeManager = managerBot({ approvalMode: "auto-safe" });
    const strongDev = plannerBot({ id: "dev", name: "Dev", approvalMode: "full" });
    const stages = [
      { id: "dev", name: "Dev", botId: "dev", kind: "work", instructions: "Do it." },
      {
        id: "check",
        name: "Check",
        botId: "manager",
        kind: "review",
        instructions: "Check it.",
        onFail: "dev",
      },
    ];

    // New members and new stage bots are checked.
    const { layer: createLayer } = layerToolkit({
      bots: [autoSafeManager, strongDev],
      ...managerCaller,
    });
    expect(
      declaredFailure(
        yield* callTool("save_team", { name: "Docs", memberBotIds: ["dev"] }).pipe(
          Effect.provide(createLayer),
        ),
      ),
    ).toMatchObject({
      code: "invalid_request",
      message:
        'You can\'t add "Dev" to a team: its approval mode ("full") is above your own ("auto-safe").',
    });
    expect(
      declaredFailure(
        yield* callTool("save_pipeline", { teamId: "build", name: "Ship", stages }).pipe(
          Effect.provide(createLayer),
        ),
      ),
    ).toMatchObject({
      code: "invalid_request",
      message:
        'Stage "Dev" can\'t use "Dev": its approval mode ("full") is above your own ("auto-safe").',
    });

    // A change can't touch a team or pipeline that already holds such a bot.
    const { calls, layer: updateLayer } = layerToolkit({
      bots: [autoSafeManager, strongDev],
      teams: [buildTeam()],
      pipelines: [shipPipeline()],
      ...managerCaller,
    });
    expect(
      declaredFailure(
        yield* callTool("save_team", { id: "build", name: "Renamed" }).pipe(
          Effect.provide(updateLayer),
        ),
      ),
    ).toMatchObject({
      code: "invalid_request",
      message:
        'You can\'t add "Dev" to a team: its approval mode ("full") is above your own ("auto-safe").',
    });
    expect(
      declaredFailure(
        yield* callTool("save_pipeline", { id: "ship", name: "Renamed" }).pipe(
          Effect.provide(updateLayer),
        ),
      ),
    ).toMatchObject({
      code: "invalid_request",
      message:
        'Stage "Dev" can\'t use "Dev": its approval mode ("full") is above your own ("auto-safe").',
    });
    expect(
      calls.filter(
        (call) =>
          typeof call === "object" &&
          call !== null &&
          "type" in call &&
          (call.type === "teamUpsert" || call.type === "pipelineUpsert"),
      ),
    ).toHaveLength(0);
  }),
);
