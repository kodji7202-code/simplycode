import { expect, it } from "@effect/vitest";
import { Bot, type BotsMcpDelegateToBotInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { botDelegateTaskInput } from "./botDelegation.ts";

const decodeBot = Schema.decodeUnknownSync(Bot);

const makeBot = (overrides?: Record<string, unknown>): Bot =>
  decodeBot({
    id: "planner",
    name: "Planner",
    enabled: true,
    pinned: false,
    projectId: "project-1",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    approvalMode: "auto-safe",
    interactionMode: "default",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    soulBytes: 0,
    threadTag: "bot:planner",
    ...overrides,
  });

const input = (overrides?: Partial<BotsMcpDelegateToBotInput>): BotsMcpDelegateToBotInput => ({
  botId: makeBot().id,
  task: "Audit the auth flow",
  ...overrides,
});

it("wraps the task with the bot's SOUL instructions", () => {
  const built = botDelegateTaskInput({
    bot: makeBot(),
    soul: "Always think in graphs.",
    input: input(),
    callerRuntimeMode: "full-access",
  });
  expect(built.task).toContain('You are "Planner", a SimplyCode bot');
  expect(built.task).toContain("Always think in graphs.");
  expect(built.task.endsWith("Audit the auth flow")).toBe(true);
});

it("leaves the task untouched when the soul is empty", () => {
  const built = botDelegateTaskInput({
    bot: makeBot(),
    soul: "",
    input: input(),
    callerRuntimeMode: "full-access",
  });
  expect(built.task).toBe("Audit the auth flow");
});

it("targets the bot's modelSelection and passes options through", () => {
  const built = botDelegateTaskInput({
    bot: makeBot({
      modelSelection: {
        instanceId: "claude",
        model: "claude-opus-4-6",
        options: [{ key: "effort", value: "high" }],
      },
    }),
    soul: "",
    input: input(),
    callerRuntimeMode: "full-access",
  });
  expect(built.target).toEqual({
    providerInstanceId: "claude",
    model: "claude-opus-4-6",
    options: [{ key: "effort", value: "high" }],
  });
});

it("leaves options out when the selection has none", () => {
  const built = botDelegateTaskInput({
    bot: makeBot(),
    soul: "",
    input: input(),
    callerRuntimeMode: "full-access",
  });
  expect(built.target).toEqual({ providerInstanceId: "codex", model: "gpt-5.4" });
  expect("options" in built.target!).toBe(false);
});

it("clamps a broad bot down to a supervised caller's runtime mode", () => {
  const built = botDelegateTaskInput({
    bot: makeBot({ approvalMode: "full" }),
    soul: "",
    input: input(),
    callerRuntimeMode: "approval-required",
  });
  expect(built.runtimeMode).toBe("approval-required");
});

it("keeps a supervised bot supervised under a full-access caller", () => {
  const built = botDelegateTaskInput({
    bot: makeBot({ approvalMode: "auto-safe" }),
    soul: "",
    input: input(),
    callerRuntimeMode: "full-access",
  });
  expect(built.runtimeMode).toBe("auto");
});

it("defaults the title to the bot name and task start, and honors an override", () => {
  const bot = makeBot();
  const defaulted = botDelegateTaskInput({
    bot,
    soul: "",
    input: input(),
    callerRuntimeMode: "auto",
  });
  expect(defaulted.title).toBe("Planner: Audit the auth flow");

  const long = botDelegateTaskInput({
    bot,
    soul: "",
    input: input({ task: "x".repeat(120) }),
    callerRuntimeMode: "auto",
  });
  expect(long.title).toBe(`Planner: ${"x".repeat(60)}`);

  const titled = botDelegateTaskInput({
    bot,
    soul: "",
    input: input({ title: "Weekly audit" }),
    callerRuntimeMode: "auto",
  });
  expect(titled.title).toBe("Weekly audit");
});

it("uses the bot's interactionMode, the general role, and passes run options through", () => {
  const built = botDelegateTaskInput({
    bot: makeBot({ interactionMode: "plan" }),
    soul: "",
    input: input({
      mode: "background",
      timeoutMs: 30_000,
      clientRequestId: "req-9",
      isolation: { type: "worktree" },
    }),
    callerRuntimeMode: "full-access",
  });
  expect(built.interactionMode).toBe("plan");
  expect(built.role).toBe("general");
  expect(built.mode).toBe("background");
  expect(built.timeoutMs).toBe(30_000);
  expect(built.clientRequestId).toBe("req-9");
  expect(built.isolation).toEqual({ type: "worktree" });
});
