import { createFileRoute } from "@tanstack/react-router";

import { BotsPage } from "../components/bots/BotsPage";

export const Route = createFileRoute("/_chat/bots")({
  validateSearch: (raw: Record<string, unknown>): { env?: string } =>
    typeof raw.env === "string" && raw.env ? { env: raw.env.slice(0, 200) } : {},
  component: BotsPage,
});
