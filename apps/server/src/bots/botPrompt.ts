export function botPrompt(bot: { readonly name: string }, soul: string, prompt: string): string {
  if (soul.length === 0) return prompt;
  return `You are "${bot.name}", a SimplyCode bot. Follow these standing instructions:\n\n${soul}\n\n---\n\n${prompt}`;
}
