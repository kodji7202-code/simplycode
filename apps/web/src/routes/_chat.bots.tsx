import { createFileRoute } from "@tanstack/react-router";

import { BotsPage } from "../components/bots/BotsPage";

export const Route = createFileRoute("/_chat/bots")({
  validateSearch: (
    raw: Record<string, unknown>,
  ): {
    env?: string;
    bot?: string;
    create?: true;
    teams?: true;
    pipeline?: string;
  } => {
    const out: { env?: string; bot?: string; create?: true; teams?: true; pipeline?: string } = {};
    if (typeof raw.env === "string" && raw.env) out.env = raw.env.slice(0, 200);
    if (typeof raw.bot === "string" && raw.bot) out.bot = raw.bot.slice(0, 48);
    if (raw.create === true) out.create = true;
    if (raw.teams === true) out.teams = true;
    if (typeof raw.pipeline === "string" && raw.pipeline) out.pipeline = raw.pipeline.slice(0, 48);
    return out;
  },
  component: BotsPage,
});
