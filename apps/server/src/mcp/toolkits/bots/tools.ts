import {
  BotsMcpCreateBotInput,
  BotsMcpCreateBotResult,
  BotsMcpDelegateToBotInput,
  BotsMcpDelegateToBotResult,
  BotsMcpGetBotInput,
  BotsMcpGetBotResult,
  BotsMcpInstallBotSkillInput,
  BotsMcpInstallBotSkillResult,
  BotsMcpListInput,
  BotsMcpListResult,
  BotsMcpUpdateBotInput,
  BotsMcpUpdateBotResult,
  BotsMcpUpdateMemoryInput,
  BotsMcpUpdateMemoryResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { BotService } from "../../../bots/BotService.ts";
import { BotStore } from "../../../bots/BotStore.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  OrchestratorMcpService.OrchestratorMcpService,
  BotStore,
  BotService,
  ProviderRegistry.ProviderRegistry,
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

const UpdateBotMemoryTool = Tool.make("update_bot_memory", {
  description:
    "Save to your persistent bot memory (MEMORY.md), which is shown to you at the start of every run. Use append for a new fact or lesson; use replace to rewrite or condense the whole memory. Only works when you are running as a bot.",
  parameters: BotsMcpUpdateMemoryInput,
  success: BotsMcpUpdateMemoryResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update bot memory")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const GetBotTool = Tool.make("get_bot", {
  description:
    "Read one bot's full profile, including its standing instructions (SOUL.md) and installed skills. Only works when you are running as a bot allowed to manage bots.",
  parameters: BotsMcpGetBotInput,
  success: BotsMcpGetBotResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a bot")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const CreateBotTool = Tool.make("create_bot", {
  description:
    "Create a new bot in your project with its own standing instructions. It uses your model unless you pick one, and its approval mode can't be higher than yours. New bots can never manage other bots. Only works when you are running as a bot allowed to manage bots.",
  parameters: BotsMcpCreateBotInput,
  success: BotsMcpCreateBotResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create a bot")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const UpdateBotTool = Tool.make("update_bot", {
  description:
    "Change another bot's name, role, description, standing instructions, model or approval mode. Fields you leave out stay as they are. You can't edit yourself or a bot that manages bots, and you can't raise approval above your own or edit a bot whose approval is above yours.",
  parameters: BotsMcpUpdateBotInput,
  success: BotsMcpUpdateBotResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update a bot")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

const InstallBotSkillTool = Tool.make("install_bot_skill", {
  description:
    "Copy a skill into a bot: sourcePath is a SKILL.md file or the folder that holds one, on this machine. Works on yourself or on a bot you are allowed to edit.",
  parameters: BotsMcpInstallBotSkillInput,
  success: BotsMcpInstallBotSkillResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Install a bot skill")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const BotsToolkit = Toolkit.make(
  ListBotsTool,
  DelegateToBotTool,
  UpdateBotMemoryTool,
  GetBotTool,
  CreateBotTool,
  UpdateBotTool,
  InstallBotSkillTool,
);
