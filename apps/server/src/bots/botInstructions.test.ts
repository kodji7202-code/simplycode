import { expect, it } from "@effect/vitest";

import { botInstructions } from "./botInstructions.ts";

const SKILLS_DIR = "/bots/dev/skills";

it("puts a soul, then the memory section with the (empty) marker", () => {
  const text = botInstructions({
    soul: "Be terse.",
    memory: "",
    skills: [],
    skillsDir: SKILLS_DIR,
  });
  expect(text).toBe(
    "Be terse.\n\n" +
      "## Your memory\n" +
      "This is your MEMORY.md, kept between runs. When you learn something worth keeping (a user preference, a project fact, a lesson from a mistake), save it with the update_bot_memory tool (on the t3-code MCP server; if your MCP tools are listed separately, look there). Keep it short and current.\n\n" +
      "(empty)",
  );
});

it("leaves the skills section out when there are no skills", () => {
  const text = botInstructions({
    soul: "Be terse.",
    memory: "Likes tests.",
    skills: [],
    skillsDir: SKILLS_DIR,
  });
  expect(text).not.toContain("Your skills");
  expect(text.endsWith("Likes tests.")).toBe(true);
});

it("lists each skill by name and clipped description under one skillsDir line", () => {
  const text = botInstructions({
    soul: "",
    memory: "",
    skillsDir: SKILLS_DIR,
    skills: [
      { name: "deploy", description: "Ships the release" },
      { name: "triage" },
      { name: "long", description: "x".repeat(200) },
    ],
  });
  expect(text).toContain(
    "## Your skills\n" +
      `Your skills are in ${SKILLS_DIR}. Each one is a folder with a SKILL.md. When a task matches a skill, read its SKILL.md first and follow it.\n` +
      "- deploy: Ships the release\n" +
      "- triage: no description\n" +
      `- long: ${"x".repeat(160)}…`,
  );
});

it("caps the skills section at 6,000 bytes and points at the folder for the rest", () => {
  const skills = Array.from({ length: 40 }, (_, index) => ({
    name: `skill-${index}`,
    description: "y".repeat(160),
  }));
  const text = botInstructions({ soul: "", memory: "", skills, skillsDir: SKILLS_DIR });
  const section = text.slice(text.indexOf("## Your skills"));
  const more = section.match(/- …and (\d+) more\./);
  expect(more).not.toBeNull();
  const shown = Number(more![1]!);
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(40);
  // The shown lines stay under the cap; the closing line is the pointer.
  expect(section.endsWith(`List ${SKILLS_DIR} to see them.`)).toBe(true);
  expect(section.split("\n").filter((line) => line.startsWith("- skill-")).length).toBe(40 - shown);
});

it("still produces the memory section when the soul is empty", () => {
  const text = botInstructions({
    soul: "",
    memory: "The user prefers dark mode.",
    skills: [],
    skillsDir: SKILLS_DIR,
  });
  expect(text.startsWith("## Your memory\n")).toBe(true);
  expect(text.endsWith("The user prefers dark mode.")).toBe(true);
});
