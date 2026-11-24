const BOT_PROMPT_HEADER_END = ", a SimplyCode bot. Follow these standing instructions:";
const BOT_PROMPT_SEPARATOR = "\n\n--- end of standing instructions ---\n\n";

export function botPrompt(bot: { readonly name: string }, soul: string, prompt: string): string {
  if (soul.length === 0) return prompt;
  return `You are "${bot.name}"${BOT_PROMPT_HEADER_END}\n\n${soul}${BOT_PROMPT_SEPARATOR}${prompt}`;
}

export function parseBotPrompt(
  text: string,
): { readonly name: string; readonly soul: string; readonly prompt: string } | null {
  if (!text.startsWith('You are "')) return null;
  const headerEnd = text.indexOf(`${BOT_PROMPT_HEADER_END}\n\n`);
  if (headerEnd === -1) return null;
  const name = text.slice('You are "'.length, headerEnd - 1);
  const body = text.slice(headerEnd + BOT_PROMPT_HEADER_END.length + 2);
  const separator = body.indexOf(BOT_PROMPT_SEPARATOR);
  if (separator === -1) return null;
  return {
    name,
    soul: body.slice(0, separator),
    prompt: body.slice(separator + BOT_PROMPT_SEPARATOR.length),
  };
}
