import { botAvatarOrDefault, type Bot, type ScheduledTask } from "@t3tools/contracts";
import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  botActivity,
  botAutomationCount,
  botToDraft,
  draftToBotUpsertInput,
  EMPTY_BOT_DRAFT,
  filterBots,
  importMemoryLabel,
  importModelLine,
  sortBotsForSidebar,
  soulByteLength,
  type BotActivity,
} from "./botPage.logic";

const bot: Bot = {
  id: "night-watch" as Bot["id"],
  name: "Night Watch",
  avatar: { shape: "hexagon", color: "#a855f7" },
  role: "Watcher",
  description: "Watches things",
  enabled: true,
  pinned: true,
  projectId: "project-1" as Bot["projectId"],
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex-1", model: "gpt-5" } as Bot["modelSelection"],
  approvalMode: "auto-safe",
  interactionMode: "default",
  canManageBots: false,
  limits: { maxStepsPerRun: 25 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  soulBytes: 4,
  memoryBytes: 0,
  skills: [],
  threadTag: "bot:night-watch",
};

describe("botToDraft", () => {
  it("round-trips an upsert", () => {
    const draft = botToDraft(bot, "soul text", "memory text");
    const input = draftToBotUpsertInput(draft, "main");
    expect(input).toMatchObject({
      id: "night-watch",
      name: "Night Watch",
      avatar: { shape: "hexagon", color: "#a855f7" },
      role: "Watcher",
      enabled: true,
      pinned: true,
      approvalMode: "auto-safe",
      workspaceStrategy: { type: "root" },
      soul: "soul text",
      memory: "memory text",
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
      ...botToDraft(bot, "", ""),
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
    const draft = { ...botToDraft(bot, "", ""), role: " ", description: "" };
    const input = draftToBotUpsertInput(draft, "main");
    expect(input?.role).toBe("");
    expect(input?.description).toBe("");
  });

  it("falls back to the stable default avatar for a bot without one", () => {
    const { avatar: _avatar, ...withoutAvatar } = bot;
    const draft = botToDraft(withoutAvatar as Bot, "", "");
    expect(draft.avatar).toEqual(botAvatarOrDefault(withoutAvatar as Bot));
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

describe("botActivity", () => {
  const shell = (over: Record<string, unknown>) =>
    ({
      tags: ["bot:night-watch"],
      title: "Nightly sweep",
      status: "settled",
      activityRunStatus: null,
      updatedAt: DateTime.makeUnsafe(new Date(1_000)),
      latestUserMessageAt: null,
      archivedAt: null,
      ...over,
    }) as never;

  it("aggregates last activity and running state from tagged shells", () => {
    const shells = [
      shell({ updatedAt: DateTime.makeUnsafe(new Date(5_000)), title: "older" }),
      shell({ updatedAt: DateTime.makeUnsafe(new Date(9_000)), title: "newest" }),
      shell({
        tags: ["bot:other"],
        updatedAt: DateTime.makeUnsafe(new Date(50_000)),
        title: "not mine",
      }),
      shell({ status: "running", updatedAt: DateTime.makeUnsafe(new Date(2_000)) }),
      shell({
        archivedAt: DateTime.makeUnsafe(new Date(99_000)),
        updatedAt: DateTime.makeUnsafe(new Date(99_000)),
      }),
    ];
    const activity = botActivity(bot, shells);
    expect(activity.lastAt).toBe(9_000);
    expect(activity.lastTitle).toBe("newest");
    expect(activity.running).toBe(true);
  });

  it("reports nothing for a bot without shells", () => {
    expect(botActivity(bot, [shell({ tags: ["bot:other"] })])).toEqual({
      lastAt: null,
      lastTitle: null,
      running: false,
    });
  });

  it("prefers latestUserMessageAt over updatedAt", () => {
    const activity = botActivity(bot, [
      shell({
        updatedAt: DateTime.makeUnsafe(new Date(1_000)),
        latestUserMessageAt: DateTime.makeUnsafe(new Date(7_000)),
        title: "user ping",
      }),
    ]);
    expect(activity.lastAt).toBe(7_000);
  });
});

describe("sortBotsForSidebar", () => {
  const named = (name: string, pinned = false): Bot => ({ ...bot, name, pinned });
  const act = (lastAt: number | null): BotActivity => ({
    lastAt,
    lastTitle: null,
    running: false,
  });

  it("orders pinned first, then activity desc, then name", () => {
    const a = named("alpha");
    const b = named("bravo", true);
    const c = named("charlie");
    const activities = new Map<Bot, BotActivity>([
      [a, act(100)],
      [b, act(1)],
      [c, act(null)],
    ]);
    expect(sortBotsForSidebar([a, b, c], (x) => activities.get(x) ?? act(null))).toEqual([b, a, c]);
    // Same activity falls back to name order.
    expect(sortBotsForSidebar([c, a], () => act(5))).toEqual([a, c]);
  });
});

describe("filterBots", () => {
  it("matches name or role, case-insensitive", () => {
    const reviewer = { ...bot, name: "Reviewer", role: "Gatekeeper" };
    const cleaner = { ...bot, name: "Cleaner", role: "" };
    expect(filterBots([reviewer, cleaner], "gate")).toEqual([reviewer]);
    expect(filterBots([reviewer, cleaner], "CLEAN")).toEqual([cleaner]);
    expect(filterBots([reviewer, cleaner], "  ")).toHaveLength(2);
    expect(filterBots([reviewer, cleaner], "zzz")).toHaveLength(0);
  });
});

describe("importModelLine", () => {
  const candidate = {
    key: "k1",
    name: "Dev",
    approvalMode: "ask" as const,
    soulBytes: 0,
    memoryBytes: 0,
    skills: [],
    automations: [],
    warnings: [],
  };
  const fallbackLabel = "sonnet (claude-1)";

  it("shows the mapped selection when present", () => {
    expect(
      importModelLine(
        {
          ...candidate,
          modelSelection: { instanceId: "devin", model: "swe-2-high" },
        } as never,
        fallbackLabel,
      ),
    ).toBe("swe-2-high (devin)");
  });

  it("uses the display-name label for a mapped selection when given one", () => {
    expect(
      importModelLine(
        {
          ...candidate,
          modelSelection: { instanceId: "devin", model: "swe-2-high" },
        } as never,
        fallbackLabel,
        undefined,
        () => "SWE-2 · Devin",
      ),
    ).toBe("SWE-2 · Devin");
  });

  it("names the source model and fallback when unmapped", () => {
    expect(importModelLine({ ...candidate, sourceModel: "swe-2-high" }, fallbackLabel)).toBe(
      "swe-2-high, not available here, will use sonnet (claude-1)",
    );
  });

  it("labels a missing source model as unknown", () => {
    expect(importModelLine(candidate, fallbackLabel)).toBe(
      "Unknown model, not available here, will use sonnet (claude-1)",
    );
  });
});

describe("importMemoryLabel", () => {
  it("pluralizes the byte count", () => {
    expect(importMemoryLabel(0)).toBe("0 bytes");
    expect(importMemoryLabel(1)).toBe("1 byte");
    expect(importMemoryLabel(1536)).toBe("1,536 bytes");
  });
});
