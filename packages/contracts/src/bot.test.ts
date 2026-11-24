import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { BotId, BotProfile, BotUpsertInput, botRuntimeMode } from "./bot.ts";

const decodeBotId = Schema.decodeUnknownSync(BotId);
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

describe("BotUpsertInput", () => {
  it("rejects a soul over the byte limit", () => {
    expect(() => decodeUpsert({ ...validProfile, soul: "x".repeat(24_001) })).toThrow();
  });
});

describe("botRuntimeMode", () => {
  it("maps each approval mode to a runtime mode", () => {
    expect(botRuntimeMode("ask")).toBe("approval-required");
    expect(botRuntimeMode("auto-safe")).toBe("auto");
    expect(botRuntimeMode("full")).toBe("full-access");
  });
});
