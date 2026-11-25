export type BotInstructionsSkills = ReadonlyArray<{
  readonly name: string;
  readonly description?: string | undefined;
  readonly path: string;
}>;

// The standing-instructions text that goes where SOUL.md alone used to go, so
// `botPrompt` wraps soul, memory and skills the same way for every caller.
export function botInstructions(input: {
  readonly soul: string;
  readonly memory: string;
  readonly skills: BotInstructionsSkills;
}): string {
  const sections: Array<string> = [];
  if (input.soul.length > 0) {
    sections.push(input.soul);
  }
  sections.push(
    "## Your memory\n" +
      "This is your MEMORY.md, kept between runs. When you learn something worth keeping (a user preference, a project fact, a lesson from a mistake), save it with the update_bot_memory tool. Keep it short and current.\n\n" +
      (input.memory.length > 0 ? input.memory : "(empty)"),
  );
  if (input.skills.length > 0) {
    sections.push(
      "## Your skills\n" +
        "Each skill is a folder with a SKILL.md. When a task matches a skill, read its SKILL.md first and follow it.\n" +
        input.skills
          .map(
            (skill) => `- ${skill.name}: ${skill.description ?? "no description"} (${skill.path})`,
          )
          .join("\n"),
    );
  }
  return sections.join("\n\n");
}
