import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  Bot,
  BotError,
  BotId,
  botThreadTag,
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestratorMcpDelegateTaskResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import { BotStore } from "../../../bots/BotStore.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as BotsHandlers from "./handlers.ts";
import { BotsToolkit } from "./tools.ts";

const decodeBot = Schema.decodeUnknownSync(Bot);

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

const layerToolkit = (input: {
  readonly bots: ReadonlyArray<Bot>;
  readonly souls?: ReadonlyMap<BotId, string>;
  readonly memories?: ReadonlyMap<BotId, string>;
  readonly callerTags?: ReadonlyArray<string>;
  readonly callerRuntimeMode?: "approval-required" | "auto" | "full-access";
}) => {
  const calls: Array<unknown> = [];
  const storedMemories = new Map(input.memories ?? []);
  const layerStore = Layer.mock(BotStore)({
    list: () => Effect.succeed({ bots: [...input.bots], loadErrors: [] }),
    get: (id) => {
      const bot = input.bots.find((entry) => entry.id === id);
      return bot === undefined
        ? Effect.fail(new BotError({ message: "Bot not found.", botId: id }))
        : Effect.succeed({
            bot,
            soul: input.souls?.get(id) ?? "",
            memory: storedMemories.get(id) ?? "",
            skills: [],
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
