import {
  type Bot,
  type BotsMcpDelegateToBotInput,
  type OrchestratorMcpDelegateTaskInput,
  botRuntimeMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { botPrompt } from "@t3tools/shared/botPrompt";

import {
  botInstructions,
  type BotInstructionsSkills,
  type BotInstructionsTeam,
} from "./botInstructions.ts";
import { runtimeModeRank } from "../mcp/delegatedTaskModes.ts";

/**
 * The `delegate_task` input that runs `task` as `bot`: its SOUL preamble, its
 * model, and the narrower of its and the caller's runtime mode, so a broad bot
 * delegated from a supervised caller stays supervised. The bot's own project
 * and workspace are deliberately left out; the child runs in the caller's.
 */
export function botDelegateTaskInput(input: {
  readonly bot: Bot;
  readonly soul: string;
  readonly memory: string;
  readonly skills: BotInstructionsSkills;
  readonly skillsDir: string;
  /** The teams the bot leads, for the team section of its instructions. */
  readonly teams?: ReadonlyArray<BotInstructionsTeam>;
  readonly input: BotsMcpDelegateToBotInput;
  readonly callerRuntimeMode: RuntimeMode;
}): OrchestratorMcpDelegateTaskInput {
  const { bot, soul, memory, skills, skillsDir, teams, input: request, callerRuntimeMode } = input;
  const botMode = botRuntimeMode(bot.approvalMode);
  const runtimeMode =
    runtimeModeRank(botMode) <= runtimeModeRank(callerRuntimeMode) ? botMode : callerRuntimeMode;
  return {
    task: botPrompt(
      bot,
      botInstructions({
        soul,
        memory,
        skills,
        skillsDir,
        ...(teams === undefined ? {} : { teams }),
      }),
      request.task,
    ),
    target: {
      providerInstanceId: bot.modelSelection.instanceId,
      model: bot.modelSelection.model,
      ...(bot.modelSelection.options === undefined ? {} : { options: bot.modelSelection.options }),
    },
    runtimeMode,
    interactionMode: bot.interactionMode,
    role: "general",
    title: request.title ?? `${bot.name}: ${request.task.slice(0, 60)}`,
    mode: request.mode,
    timeoutMs: request.timeoutMs,
    clientRequestId: request.clientRequestId,
    isolation: request.isolation,
  };
}
