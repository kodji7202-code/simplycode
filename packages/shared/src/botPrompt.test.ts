import { describe, expect, it } from "vite-plus/test";

import { botPrompt, parseBotPrompt } from "./botPrompt.ts";

describe("botPrompt", () => {
  it("returns the prompt unchanged when the soul is empty", () => {
    expect(botPrompt({ name: "Reviewer" }, "", "Check the diff.")).toBe("Check the diff.");
  });

  it("wraps the prompt with the standing instructions", () => {
    expect(botPrompt({ name: "Reviewer" }, "Always be terse.", "Check the diff.")).toBe(
      'You are "Reviewer", a SimplyCode bot. Follow these standing instructions:\n\nAlways be terse.\n\n--- end of standing instructions ---\n\nCheck the diff.',
    );
  });
});

describe("parseBotPrompt", () => {
  it("round-trips a wrapped prompt", () => {
    const wrapped = botPrompt({ name: "Reviewer" }, "Always be terse.\nBe kind.", "Check it.");
    expect(parseBotPrompt(wrapped)).toEqual({
      name: "Reviewer",
      soul: "Always be terse.\nBe kind.",
      prompt: "Check it.",
    });
  });

  it("returns null for an empty-soul passthrough", () => {
    expect(parseBotPrompt("Check the diff.")).toBeNull();
  });

  it("returns null when only the header matches", () => {
    expect(
      parseBotPrompt(
        'You are "Reviewer", a SimplyCode bot. Follow these standing instructions:\n\nno separator',
      ),
    ).toBeNull();
    expect(parseBotPrompt('You are "Reviewer", check this.')).toBeNull();
  });

  it("round-trips a soul containing --- lines", () => {
    const soul = "First rule.\n\n---\n\nSecond rule.";
    const wrapped = botPrompt({ name: "Reviewer" }, soul, "Check the diff.");
    expect(parseBotPrompt(wrapped)).toEqual({
      name: "Reviewer",
      soul,
      prompt: "Check the diff.",
    });
  });
});
