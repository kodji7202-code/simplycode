import {
  BotsMcpDelegateToBotInput,
  BotsMcpDelegateToBotResult,
  BotsMcpListInput,
  BotsMcpListResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { BotStore } from "../../../bots/BotStore.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  OrchestratorMcpService.OrchestratorMcpService,
  BotStore,
  Orchestrator.OrchestratorV2,
];

const ListBotsTool = Tool.make("list_bots", {
  description:
    "List enabled bots you can hand work to with `delegate_to_bot`. `selfBotId` is the bot you are running as, if any.",
  parameters: BotsMcpListInput,
  success: BotsMcpListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List bots")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const DelegateToBotTool = Tool.make("delegate_to_bot", {
  description:
    "Hand `task` to a bot from `list_bots`. It runs with that bot's instructions, model and approval mode, in this project, and returns like `delegate_task`. Use `task_status`/`task_cancel` with its `taskId`.",
  parameters: BotsMcpDelegateToBotInput,
  success: BotsMcpDelegateToBotResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delegate a task to a bot")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const BotsToolkit = Toolkit.make(ListBotsTool, DelegateToBotTool);
