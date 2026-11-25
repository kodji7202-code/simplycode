// The source's provider maps to the instance whose id or driver matches it
// (case-insensitive); the model must be one of that instance's known slugs.
// Shared by the import readers and the bot-management tools' model check.
import { type ModelSelection, type ServerProvider } from "@t3tools/contracts";

export const mapModelSelection = (
  source: {
    readonly sourceProvider: string | undefined;
    readonly sourceModelSlug: string | undefined;
  },
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | undefined => {
  if (source.sourceModelSlug === undefined || source.sourceProvider === undefined) return undefined;
  const wanted = source.sourceProvider.toLowerCase();
  for (const provider of providers) {
    const matchesInstance =
      provider.instanceId.toLowerCase() === wanted || provider.driver.toLowerCase() === wanted;
    if (!matchesInstance) continue;
    const model = provider.models.find((entry) => entry.slug === source.sourceModelSlug);
    if (model !== undefined) {
      return { instanceId: provider.instanceId, model: model.slug };
    }
  }
  return undefined;
};
