import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { Bot, BotId, BotProfile, BotUpsertInput, botRuntimeMode } from "./bot.ts";

const decodeBotId = Schema.decodeUnknownSync(BotId);
const decodeBot = Schema.decodeUnknownSync(Bot);
const decodeProfile = Schema.decodeUnknownSync(BotProfile);
const decodeUpsert = Schema.decodeUnknownSync(BotUpsertInput);

const validProfile = {
  id: "night-watch",
  name: "Night Watch",
  enabled: true,
  projectId: "project-1",
  workspaceStrategy: { type: "root" },
  modelSelection: { provider: "codex", model: "gpt-5" },
  approvalMode: "auto-safe",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("BotId", () => {
  it.each(["a", "night-watch", "bot-2", "a".padEnd(48, "x")])("accepts %s", (id) => {
    expect(decodeBotId(id)).toBe(id);
  });

  it.each(["A", "-lead", "", "has space", "has_underscore", "x".padEnd(49, "x")])(
    "rejects %s",
    (id) => {
      expect(() => decodeBotId(id)).toThrow();
    },
  );
});

describe("BotProfile", () => {
  it("decodes a stored profile and defaults interactionMode and limits", () => {
    const profile = decodeProfile(validProfile);
    expect(profile.interactionMode).toBe("default");
    expect(profile.limits).toEqual({});
  });

  it("rejects a multi-line name", () => {
    expect(() => decodeProfile({ ...validProfile, name: "two\nlines" })).toThrow();
  });
});

describe("Bot", () => {
  const wireBot = { ...validProfile, soulBytes: 0, threadTag: "bot:night-watch" };

  it("defaults memoryBytes and skills for a wire item written before they existed", () => {
    const bot = decodeBot(wireBot);
    expect(bot.memoryBytes).toBe(0);
    expect(bot.skills).toEqual([]);
  });

  it("decodes memoryBytes and skills", () => {
    const bot = decodeBot({
      ...wireBot,
      memoryBytes: 12,
      skills: [{ name: "deploy", description: "Ships the release" }, { name: "triage" }],
    });
    expect(bot.memoryBytes).toBe(12);
    expect(bot.skills).toEqual([
      { name: "deploy", description: "Ships the release" },
      { name: "triage" },
    ]);
  });
});

describe("BotUpsertInput", () => {
  it("rejects a soul over the byte limit", () => {
    expect(() => decodeUpsert({ ...validProfile, soul: "x".repeat(24_001) })).toThrow();
  });

  it("rejects a memory over the byte limit", () => {
    expect(() => decodeUpsert({ ...validProfile, memory: "x".repeat(16_001) })).toThrow();
  });
});

describe("botRuntimeMode", () => {
  it("maps each approval mode to a runtime mode", () => {
    expect(botRuntimeMode("ask")).toBe("approval-required");
    expect(botRuntimeMode("auto-safe")).toBe("auto");
    expect(botRuntimeMode("full")).toBe("full-access");
  });
});
