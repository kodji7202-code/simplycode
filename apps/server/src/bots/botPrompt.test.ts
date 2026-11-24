import { describe, expect, it } from "vite-plus/test";

import { botPrompt } from "./botPrompt.ts";

describe("botPrompt", () => {
  it("returns the prompt unchanged when the soul is empty", () => {
    expect(botPrompt({ name: "Reviewer" }, "", "Check the diff.")).toBe("Check the diff.");
  });

  it("wraps the prompt with the standing instructions", () => {
    expect(botPrompt({ name: "Reviewer" }, "Always be terse.", "Check the diff.")).toBe(
      'You are "Reviewer", a SimplyCode bot. Follow these standing instructions:\n\nAlways be terse.\n\n---\n\nCheck the diff.',
    );
  });
});
