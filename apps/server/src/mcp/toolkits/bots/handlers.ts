import { BotId, botThreadTag, CommandId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { botDelegateTaskInput } from "../../../bots/botDelegation.ts";
import { BotStore } from "../../../bots/BotStore.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { loadCaller, readCaller } from "../../threadAccess.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { BotsToolkit } from "./tools.ts";

const botIdFromTags = (tags: ReadonlyArray<string> | undefined): string | null =>
  tags?.find((tag) => tag.startsWith("bot:"))?.slice("bot:".length) ?? null;

const invalidRequest = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const handlers = {
  list_bots: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const store = yield* BotStore;
      const { bots } = yield* store.list();
      const { caller } = yield* loadCaller();
      const selfBotId = botIdFromTags(caller?.tags);
      return {
        selfBotId: selfBotId === null ? null : BotId.make(selfBotId),
        bots: bots
          .filter((bot) => bot.enabled)
          .map((bot) => ({
            id: bot.id,
            name: bot.name,
            role: bot.role,
            description: bot.description,
            providerInstanceId: bot.modelSelection.instanceId,
            model: bot.modelSelection.model,
            approvalMode: bot.approvalMode,
          })),
      };
    }),
  ),
  delegate_to_bot: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const store = yield* BotStore;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { scope, caller } = yield* readCaller();
      const { bot, soul } = yield* store
        .get(input.botId)
        .pipe(Effect.mapError(() => invalidRequest("Bot not found.")));
      if (!bot.enabled) return yield* invalidRequest("Bot is disabled.");
      if (caller === undefined) {
        return yield* invalidRequest("delegate_to_bot runs inside a T3 thread.");
      }
      if (caller.tags?.includes(botThreadTag(input.botId)) === true) {
        return yield* invalidRequest("A bot cannot delegate to itself.");
      }
      const result = yield* service.delegateTask(
        scope,
        botDelegateTaskInput({
          bot,
          soul,
          input,
          callerRuntimeMode: caller.runtimeMode,
        }),
      );
      if (result.childThreadId !== null) {
        yield* orchestrator
          .dispatch({
            type: "thread.tag.set",
            commandId: CommandId.make(`bot-tag:delegate:${result.taskId}`),
            threadId: result.childThreadId,
            tag: botThreadTag(input.botId),
            tagged: true,
          })
          .pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Could not tag a delegated bot thread", {
                botId: input.botId,
              }),
            ),
          );
      }
      return { ...result, botId: input.botId };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof BotsToolkit.tools>;

export const layer = McpToolAccess.toLayer(BotsToolkit, handlers);
