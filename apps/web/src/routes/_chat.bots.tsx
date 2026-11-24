import { createFileRoute } from "@tanstack/react-router";

import { BotsPage } from "../components/bots/BotsPage";

export const Route = createFileRoute("/_chat/bots")({
  validateSearch: (
    raw: Record<string, unknown>,
  ): {
    env?: string;
    bot?: string;
    create?: true;
  } => {
    const out: { env?: string; bot?: string; create?: true } = {};
    if (typeof raw.env === "string" && raw.env) out.env = raw.env.slice(0, 200);
    if (typeof raw.bot === "string" && raw.bot) out.bot = raw.bot.slice(0, 48);
    if (raw.create === true) out.create = true;
    return out;
  },
  component: BotsPage,
});
