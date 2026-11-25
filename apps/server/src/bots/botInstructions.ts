export type BotInstructionsSkills = ReadonlyArray<{
  readonly name: string;
  readonly description?: string | undefined;
}>;

const SKILLS_SECTION_MAX_BYTES = 6_000;
const SKILL_DESCRIPTION_MAX_CHARS = 160;

// Long skill lists ride the first message of every run, so each description is
// kept to one short line and the whole section stays under a byte cap.
const clipSkillDescription = (description: string): string => {
  const flat = description.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= SKILL_DESCRIPTION_MAX_CHARS
    ? flat
    : `${chars.slice(0, SKILL_DESCRIPTION_MAX_CHARS).join("")}…`;
};

// The standing-instructions text that goes where SOUL.md alone used to go, so
// `botPrompt` wraps soul, memory and skills the same way for every caller.
export function botInstructions(input: {
  readonly soul: string;
  readonly memory: string;
  readonly skills: BotInstructionsSkills;
  /** The bot's `skills/` folder; printed once so the agent can list it. */
  readonly skillsDir: string;
}): string {
  const sections: Array<string> = [];
  if (input.soul.length > 0) {
    sections.push(input.soul);
  }
  sections.push(
    "## Your memory\n" +
      "This is your MEMORY.md, kept between runs. When you learn something worth keeping (a user preference, a project fact, a lesson from a mistake), save it with the update_bot_memory tool (on the t3-code MCP server; if your MCP tools are listed separately, look there). Keep it short and current.\n\n" +
      (input.memory.length > 0 ? input.memory : "(empty)"),
  );
  if (input.skills.length > 0) {
    let skillsSection =
      "## Your skills\n" +
      `Your skills are in ${input.skillsDir}. Each one is a folder with a SKILL.md. When a task matches a skill, read its SKILL.md first and follow it.`;
    let shown = 0;
    for (const skill of input.skills) {
      const line = `- ${skill.name}: ${
        skill.description === undefined ? "no description" : clipSkillDescription(skill.description)
      }`;
      if (Buffer.byteLength(`${skillsSection}\n${line}`, "utf8") > SKILLS_SECTION_MAX_BYTES) break;
      skillsSection += `\n${line}`;
      shown += 1;
    }
    if (shown < input.skills.length) {
      skillsSection += `\n- …and ${input.skills.length - shown} more. List ${input.skillsDir} to see them.`;
    }
    sections.push(skillsSection);
  }
  return sections.join("\n\n");
}
