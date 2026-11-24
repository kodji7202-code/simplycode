// Bots as a user-facing concept: a profile on disk plus threads it launches.
// Bot automations are ordinary scheduled tasks carrying a `botId`; this service
// owns profile CRUD, run-now launches, and the ScheduledTaskBotHook that wraps
// prompts, tags threads, and blocks tasks whose bot is gone or disabled.
import {
  BotError,
  BotId,
  type Bot,
  type BotDeleteInput,
  type BotDeleteResult,
  type BotGetInput,
  type BotGetResult,
  type BotListInput,
  type BotListResult,
  type BotMutationResult,
  type BotProfile,
  type BotRunNowInput,
  type BotRunNowResult,
  type BotSetEnabledInput,
  type BotUpsertInput,
  botRuntimeMode,
  botThreadTag,
  CommandId,
  MessageId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import { BotStore } from "./BotStore.ts";
import { botPrompt } from "./botPrompt.ts";

function botError(message: string, input?: { botId?: BotId; cause?: unknown }) {
  return new BotError({
    message,
    ...(input?.botId === undefined ? {} : { botId: input.botId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

/**
 * The scheduled-task side of bots, provided to ScheduledTaskService at layer
 * build. Built over BotStore and the orchestrator only, never over
 * ScheduledTaskService itself, so the layers cannot cycle.
 */
export const botHookLayer = Layer.unwrap(
  Effect.gen(function* () {
    const store = yield* BotStore;
    const orchestrator = yield* Orchestrator.OrchestratorV2;

    const prompt: ScheduledTasks.ScheduledTaskBotHookShape["prompt"] = Effect.fn(
      "ScheduledTaskBotHook.prompt",
    )(function* (task, text, context) {
      if (task.botId === undefined) return text;
      if (!context.launching && !context.freshContext) return text;
      const entry = yield* store.get(task.botId).pipe(Effect.result);
      if (entry._tag === "Failure") return text;
      return botPrompt(entry.success.bot, entry.success.soul, text);
    });

    const afterLaunch: ScheduledTasks.ScheduledTaskBotHookShape["afterLaunch"] = Effect.fn(
      "ScheduledTaskBotHook.afterLaunch",
    )(function* (task, threadId) {
      if (task.botId === undefined) return;
      yield* orchestrator
        .dispatch({
          type: "thread.tag.set",
          commandId: CommandId.make(`bot-tag:${task.id}:${threadId}`),
          threadId,
          tag: botThreadTag(task.botId),
          tagged: true,
        })
        .pipe(
          Effect.catchCause(() =>
            Effect.logWarning("Could not tag a bot thread", { taskId: task.id }),
          ),
        );
    });

    const blocked: ScheduledTasks.ScheduledTaskBotHookShape["blocked"] = Effect.fn(
      "ScheduledTaskBotHook.blocked",
    )(function* (task) {
      if (task.botId === undefined) return undefined;
      const bot = yield* store.find(task.botId);
      if (bot === undefined) return "Its bot was deleted.";
      if (!bot.enabled) return "Its bot is disabled.";
      return undefined;
    });

    const botExists: ScheduledTasks.ScheduledTaskBotHookShape["botExists"] = (id) =>
      store.find(id).pipe(Effect.map((bot) => bot !== undefined));

    return Layer.succeed(ScheduledTasks.ScheduledTaskBotHook, {
      prompt,
      afterLaunch,
      blocked,
      botExists,
    });
  }),
);

export class BotService extends Context.Service<
  BotService,
  {
    readonly list: (input: BotListInput) => Effect.Effect<BotListResult>;
    readonly subscribeList: (input: BotListInput) => Stream.Stream<BotListResult, BotError>;
    readonly get: (input: BotGetInput) => Effect.Effect<BotGetResult, BotError>;
    readonly upsert: (input: BotUpsertInput) => Effect.Effect<BotMutationResult, BotError>;
    readonly setEnabled: (input: BotSetEnabledInput) => Effect.Effect<BotMutationResult, BotError>;
    readonly delete: (input: BotDeleteInput) => Effect.Effect<BotDeleteResult, BotError>;
    readonly runNow: (input: BotRunNowInput) => Effect.Effect<BotRunNowResult, BotError>;
  }
>()("simplycode/bots/BotService") {}

export const layer = Layer.effect(
  BotService,
  Effect.gen(function* () {
    const store = yield* BotStore;
    const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projectStore = yield* ProjectStore.ProjectStoreV2;

    const requireProject = Effect.fnUntraced(function* (
      projectId: Bot["projectId"],
      botId?: BotId,
    ) {
      const project = yield* projectStore
        .get(projectId)
        .pipe(
          Effect.mapError((cause) =>
            botError("Could not load the project.", botId === undefined ? {} : { botId, cause }),
          ),
        );
      if (Option.isNone(project)) {
        return yield* botError("Project not found.", botId === undefined ? {} : { botId });
      }
    });

    const toProfile = (bot: Bot): BotProfile => {
      const { soulBytes: _soulBytes, threadTag: _threadTag, ...profile } = bot;
      return profile;
    };

    const upsert: BotService["Service"]["upsert"] = Effect.fn("BotService.upsert")(
      function* (input) {
        yield* requireProject(input.projectId, input.id);
        const existing = input.id === undefined ? undefined : yield* store.find(input.id);
        if (input.id !== undefined && existing === undefined) {
          return yield* botError("Bot not found.", { botId: input.id });
        }
        const id =
          input.id ??
          (yield* store
            .allocateId(input.name)
            .pipe(Effect.mapError((cause) => botError("Could not allocate a bot id.", { cause }))));
        const now = DateTime.formatIso(yield* DateTime.now);
        const profile: BotProfile = {
          id,
          name: input.name,
          enabled: input.enabled,
          projectId: input.projectId,
          workspaceStrategy: input.workspaceStrategy,
          modelSelection: input.modelSelection,
          approvalMode: input.approvalMode,
          interactionMode: input.interactionMode ?? existing?.interactionMode ?? "default",
          limits: input.limits ?? existing?.limits ?? {},
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          ...(input.avatar === undefined ? {} : { avatar: input.avatar }),
          ...(input.description === undefined ? {} : { description: input.description }),
        };
        const bot = yield* store.write(profile, input.soul);
        return { bot };
      },
    );

    const setEnabled: BotService["Service"]["setEnabled"] = Effect.fn("BotService.setEnabled")(
      function* (input) {
        const { bot } = yield* store.get(input.id);
        const now = DateTime.formatIso(yield* DateTime.now);
        const written = yield* store.write({
          ...toProfile(bot),
          enabled: input.enabled,
          updatedAt: now,
        });
        return { bot: written };
      },
    );

    const deleteBot: BotService["Service"]["delete"] = Effect.fn("BotService.delete")(
      function* (input) {
        yield* store.get(input.id);
        const { tasks } = yield* scheduledTasks
          .list()
          .pipe(Effect.mapError((cause) => botError("Could not list schedule tasks.", { cause })));
        for (const task of tasks) {
          if (task.botId !== input.id) continue;
          yield* scheduledTasks
            .delete({ id: task.id })
            .pipe(Effect.mapError((cause) => botError(cause.message, { botId: input.id, cause })));
        }
        yield* store.remove(input.id);
        return { id: input.id };
      },
    );

    const runNow: BotService["Service"]["runNow"] = Effect.fn("BotService.runNow")(
      function* (input) {
        const { bot, soul } = yield* store.get(input.id);
        if (!bot.enabled) return yield* botError("Bot is disabled.", { botId: input.id });
        yield* requireProject(bot.projectId, input.id);
        const commandId =
          input.commandId ??
          CommandId.make(`bot-run:${input.id}:${DateTime.toEpochMillis(yield* DateTime.now)}`);
        const launched = yield* threadLaunch
          .launch({
            commandId,
            projectId: bot.projectId,
            title: `${bot.name}: ${input.prompt.slice(0, 60)}`,
            modelSelection: bot.modelSelection,
            runtimeMode: botRuntimeMode(bot.approvalMode),
            interactionMode: bot.interactionMode,
            workspaceStrategy: bot.workspaceStrategy,
            initialMessage: {
              messageId: MessageId.make(`bot-message:${commandId}`),
              text: botPrompt(bot, soul, input.prompt),
              attachments: [],
            },
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(
            Effect.mapError((cause) =>
              botError("Could not launch the bot thread.", { botId: input.id, cause }),
            ),
          );
        yield* orchestrator
          .dispatch({
            type: "thread.tag.set",
            commandId: CommandId.make(`bot-tag:${commandId}`),
            threadId: launched.threadId,
            tag: botThreadTag(input.id),
            tagged: true,
          })
          .pipe(
            Effect.mapError((cause) =>
              botError("Could not tag the bot thread.", { botId: input.id, cause }),
            ),
          );
        return { threadId: launched.threadId };
      },
    );

    return BotService.of({
      list: Effect.fn("BotService.list")(() => store.list()),
      subscribeList: () => store.subscribeList(),
      get: Effect.fn("BotService.get")((input) => store.get(input.id)),
      upsert,
      setEnabled,
      delete: deleteBot,
      runNow,
    });
  }),
);
