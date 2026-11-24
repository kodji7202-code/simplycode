import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: process.env.APP_VARIANT }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "io.github.kodji7202code.simplycode"],
  ["development", "io.github.kodji7202code.simplycode.dev"],
  ["preview", "io.github.kodji7202code.simplycode.preview"],
  ["production", "io.github.kodji7202code.simplycode"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // The fork ships no hosted surface; applinks activate only when
  // SIMPLYCODE_CLERK_RP_DOMAIN is set at build time.
  expect(config.ios?.associatedDomains).toBeUndefined();
  expect(config.android?.intentFilters).toEqual([]);
  expect(appleAppSiteAssociation.applinks.details).toEqual([]);
  expect(assetLinks).toEqual([]);
});
