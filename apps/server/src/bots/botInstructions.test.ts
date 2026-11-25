import { expect, it } from "@effect/vitest";

import { botInstructions } from "./botInstructions.ts";

it("puts a soul, then the memory section with the (empty) marker", () => {
  const text = botInstructions({ soul: "Be terse.", memory: "", skills: [] });
  expect(text).toBe(
    "Be terse.\n\n" +
      "## Your memory\n" +
      "This is your MEMORY.md, kept between runs. When you learn something worth keeping (a user preference, a project fact, a lesson from a mistake), save it with the update_bot_memory tool. Keep it short and current.\n\n" +
      "(empty)",
  );
});

it("leaves the skills section out when there are no skills", () => {
  const text = botInstructions({ soul: "Be terse.", memory: "Likes tests.", skills: [] });
  expect(text).not.toContain("Your skills");
  expect(text.endsWith("Likes tests.")).toBe(true);
});

it("lists each skill with its description and SKILL.md path", () => {
  const text = botInstructions({
    soul: "",
    memory: "",
    skills: [
      {
        name: "deploy",
        description: "Ships the release",
        path: "/bots/dev/skills/deploy/SKILL.md",
      },
      { name: "triage", path: "/bots/dev/skills/triage/SKILL.md" },
    ],
  });
  expect(text).toContain(
    "## Your skills\n" +
      "Each skill is a folder with a SKILL.md. When a task matches a skill, read its SKILL.md first and follow it.\n" +
      "- deploy: Ships the release (/bots/dev/skills/deploy/SKILL.md)\n" +
      "- triage: no description (/bots/dev/skills/triage/SKILL.md)",
  );
});

it("still produces the memory section when the soul is empty", () => {
  const text = botInstructions({ soul: "", memory: "The user prefers dark mode.", skills: [] });
  expect(text.startsWith("## Your memory\n")).toBe(true);
  expect(text.endsWith("The user prefers dark mode.")).toBe(true);
});
