import type { Bot, ScheduledTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botAutomationCount,
  botToDraft,
  draftToBotUpsertInput,
  EMPTY_BOT_DRAFT,
  soulByteLength,
} from "./botPage.logic";

const bot: Bot = {
  id: "night-watch" as Bot["id"],
  name: "Night Watch",
  avatar: "🌙",
  description: "Watches things",
  enabled: true,
  projectId: "project-1" as Bot["projectId"],
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex-1", model: "gpt-5" } as Bot["modelSelection"],
  approvalMode: "auto-safe",
  interactionMode: "default",
  limits: { maxStepsPerRun: 25 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  soulBytes: 4,
  threadTag: "bot:night-watch",
};

describe("botToDraft", () => {
  it("round-trips an upsert", () => {
    const draft = botToDraft(bot, "soul text");
    const input = draftToBotUpsertInput(draft, "main");
    expect(input).toMatchObject({
      id: "night-watch",
      name: "Night Watch",
      avatar: "🌙",
      enabled: true,
      approvalMode: "auto-safe",
      workspaceStrategy: { type: "root" },
      soul: "soul text",
      limits: { maxStepsPerRun: 25 },
    });
  });

  it("rejects a draft without a name or model", () => {
    expect(draftToBotUpsertInput(EMPTY_BOT_DRAFT, "main")).toBeNull();
    expect(draftToBotUpsertInput({ ...EMPTY_BOT_DRAFT, name: "x" }, "main")).toBeNull();
  });

  it("accepts a new bot once the resolved display defaults fill the draft", () => {
    // A fresh draft keeps modelSelection null; the submit path must pass the
    // picker's resolved default, or the upsert silently returns null.
    const draft = {
      ...EMPTY_BOT_DRAFT,
      name: "Night Watch",
      projectId: "project-1",
      modelSelection: { instanceId: "codex-1", model: "gpt-5" } as Bot["modelSelection"],
    };
    expect(draftToBotUpsertInput(draft, "main")).toMatchObject({
      name: "Night Watch",
      projectId: "project-1",
      modelSelection: { instanceId: "codex-1", model: "gpt-5" },
      workspaceStrategy: { type: "root" },
      approvalMode: "ask",
      enabled: true,
    });
  });

  it("builds a worktree strategy with the resolved base ref", () => {
    const draft = {
      ...botToDraft(bot, ""),
      workspaceMode: "worktree" as const,
    };
    const input = draftToBotUpsertInput(draft, "origin/main");
    expect(input?.workspaceStrategy).toEqual({
      type: "worktree",
      baseRef: "origin/main",
      startFromOrigin: true,
    });
  });

  it("clears optional fields with empty strings", () => {
    const draft = { ...botToDraft(bot, ""), avatar: " ", description: "" };
    const input = draftToBotUpsertInput(draft, "main");
    expect(input?.avatar).toBe("");
    expect(input?.description).toBe("");
  });
});

describe("soulByteLength", () => {
  it("counts UTF-8 bytes", () => {
    expect(soulByteLength("abc")).toBe(3);
    expect(soulByteLength("🌙")).toBe(4);
  });
});

describe("botAutomationCount", () => {
  it("counts only tasks bound to the bot", () => {
    const tasks = [
      { botId: "night-watch" },
      { botId: "other" },
      { botId: "night-watch" },
      {},
    ] as unknown as ReadonlyArray<ScheduledTask>;
    expect(botAutomationCount(tasks, "night-watch" as Bot["id"])).toBe(2);
  });
});
