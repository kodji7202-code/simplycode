import {
  type Bot,
  BotId,
  BOT_MEMORY_MAX_BYTES,
  botThreadTag,
  CommandId,
  type ModelSelection,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  type PipelineStage,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  canonicalPathForContainment,
  pathContainedInRoots,
  resolveContainedPath,
} from "@t3tools/shared/pathContainment";
import * as Effect from "effect/Effect";

import { botDelegateTaskInput } from "../../../bots/botDelegation.ts";
import * as BotManagerPolicy from "../../../bots/botManagerPolicy.ts";
import { BotService } from "../../../bots/BotService.ts";
import { BotStore } from "../../../bots/BotStore.ts";
import { teamsLedBy } from "../../../bots/botTeams.ts";
import { PipelineService } from "../../../bots/PipelineService.ts";
import { TeamService } from "../../../bots/TeamService.ts";
import { TeamStore } from "../../../bots/TeamStore.ts";
import * as ProjectStore from "../../../orchestration-v2/ProjectStore.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { loadCaller, newCommandId, readCaller, resolveProjectId } from "../../threadAccess.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { BotsToolkit } from "./tools.ts";

const botIdFromTags = (tags: ReadonlyArray<string> | undefined): string | null =>
  tags?.find((tag) => tag.startsWith("bot:"))?.slice("bot:".length) ?? null;

const invalidRequest = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

// The bot-management tools all start at the same gate: the caller must be a
// thread running as an enabled bot that opted into managing bots.
const loadCallerBot = Effect.gen(function* () {
  const store = yield* BotStore;
  const { caller } = yield* loadCaller();
  const selfBotId = caller === undefined ? null : botIdFromTags(caller.tags);
  if (selfBotId === null) {
    return yield* invalidRequest(BotManagerPolicy.NOT_A_MANAGER_MESSAGE);
  }
  const stored = yield* store
    .get(BotId.make(selfBotId))
    .pipe(Effect.orElseSucceed(() => undefined));
  if (stored === undefined) {
    return yield* invalidRequest(BotManagerPolicy.NOT_A_MANAGER_MESSAGE);
  }
  const denial = BotManagerPolicy.managerDenial(stored.bot);
  if (denial !== undefined) {
    return yield* invalidRequest(denial);
  }
  return stored.bot;
});

const loadTargetBot = Effect.fn("loadTargetBot")(function* (botId: BotId) {
  const service = yield* BotService;
  const stored = yield* service.get({ id: botId }).pipe(Effect.orElseSucceed(() => undefined));
  if (stored === undefined) {
    return yield* invalidRequest(`Bot "${botId}" was not found.`);
  }
  return stored.bot;
});

const resolveModel = Effect.fn("resolveModel")(function* (
  pick: { readonly providerInstanceId: ProviderInstanceId; readonly model: string } | undefined,
  fallback: ModelSelection,
) {
  if (pick === undefined) return fallback;
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const providers = yield* registry.getProviders;
  const resolved = BotManagerPolicy.resolveModelPick(pick, providers);
  if ("denial" in resolved) {
    return yield* invalidRequest(resolved.denial);
  }
  return resolved.modelSelection;
});

/** The bots behind `ids`; missing ones skip the check — the service reports them. */
const loadBots = Effect.fn("loadBots")(function* (ids: ReadonlyArray<BotId>) {
  const store = yield* BotStore;
  const found = yield* Effect.forEach(ids, (id) =>
    store.find(id).pipe(Effect.orElseSucceed(() => undefined)),
  );
  return found.filter((bot): bot is Bot => bot !== undefined);
});

const stageBots = Effect.fn("stageBots")(function* (stages: ReadonlyArray<PipelineStage>) {
  const store = yield* BotStore;
  const found = yield* Effect.forEach(stages, (stage) =>
    store.find(stage.botId).pipe(
      Effect.orElseSucceed(() => undefined),
      Effect.map((bot) => ({ stage, bot })),
    ),
  );
  return found
    .filter((entry): entry is { stage: PipelineStage; bot: Bot } => entry.bot !== undefined)
    .map((entry) => ({ stage: entry.stage.name, bot: entry.bot }));
});

/** The folder a skill path names, whether it is the folder or its SKILL.md file. */
const skillFolderOf = (path: string) =>
  /[/\\]skill\.md$/i.test(path) ? path.replace(/[/\\]skill\.md$/i, "") : path;

/** The folder the calling thread's project lives in: its worktree when it has one. */
const callerProjectRoot = (caller: OrchestrationV2ThreadShell | undefined) =>
  caller === undefined
    ? Effect.succeed(null)
    : caller.worktreePath !== null
      ? Effect.succeed(caller.worktreePath)
      : ProjectStore.ProjectStoreV2.pipe(
          Effect.flatMap((projects) => projects.get(caller.projectId)),
          Effect.map((project) => (project._tag === "Some" ? project.value.workspaceRoot : null)),
          Effect.orElseSucceed(() => null),
        );

/** Every skill path this server's providers already discovered, machine- and workspace-level. */
const knownProviderSkillPaths = Effect.gen(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const providers = yield* registry.getProviders;
  const paths: Array<string> = [];
  for (const provider of providers) {
    for (const skill of provider.skills) paths.push(skill.path);
    for (const snapshot of provider.workspaceSnapshots ?? []) {
      for (const skill of snapshot.skills) paths.push(skill.path);
    }
  }
  return paths;
});

/**
 * A bot may install a skill only from inside its own project, or from a path a provider's skill
 * scan already reported. Anything else on disk is refused.
 */
const skillSourceAllowed = (
  sourcePath: string,
  projectRoot: string | null,
  knownSkillPaths: ReadonlyArray<string>,
): boolean => {
  if (projectRoot !== null) {
    const resolved = resolveContainedPath(sourcePath, projectRoot);
    if (resolved !== undefined && pathContainedInRoots(resolved, [projectRoot])) return true;
  }
  const canonicalSource = canonicalPathForContainment(skillFolderOf(sourcePath));
  if (canonicalSource === undefined) return false;
  return knownSkillPaths.some(
    (known) => canonicalPathForContainment(skillFolderOf(known)) === canonicalSource,
  );
};

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
      const { bot, soul, memory, skills, skillsDir } = yield* store
        .get(input.botId)
        .pipe(Effect.mapError(() => invalidRequest("Bot not found.")));
      if (!bot.enabled) return yield* invalidRequest("Bot is disabled.");
      if (caller === undefined) {
        return yield* invalidRequest("delegate_to_bot runs inside a T3 thread.");
      }
      if (caller.tags?.includes(botThreadTag(input.botId)) === true) {
        return yield* invalidRequest("A bot cannot delegate to itself.");
      }
      const teamStore = yield* TeamStore;
      const result = yield* service.delegateTask(
        scope,
        botDelegateTaskInput({
          bot,
          soul,
          memory,
          skills,
          skillsDir,
          teams: yield* teamsLedBy(store, teamStore, input.botId),
          input,
          callerRuntimeMode: caller.runtimeMode,
        }),
        { workspaceConfined: bot.stayInProject },
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
  update_bot_memory: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const store = yield* BotStore;
      const { caller } = yield* loadCaller();
      const selfBotId = caller === undefined ? null : botIdFromTags(caller.tags);
      if (selfBotId === null) {
        return yield* invalidRequest("update_bot_memory only works in a bot's own thread.");
      }
      const botId = BotId.make(selfBotId);
      const { memory } = yield* store
        .get(botId)
        .pipe(Effect.mapError(() => invalidRequest("Bot not found.")));
      const next =
        input.mode === "replace"
          ? input.text
          : memory.length === 0
            ? input.text
            : `${memory}\n\n${input.text}`;
      if (Buffer.byteLength(next, "utf8") > BOT_MEMORY_MAX_BYTES) {
        return yield* invalidRequest(
          "That would put the memory over its 16 KB limit. Condense it and use replace.",
        );
      }
      const memoryBytes = yield* store
        .writeMemory(botId, next)
        .pipe(Effect.mapError((error) => invalidRequest(error.message)));
      return { botId, memoryBytes };
    }),
  ),
  get_bot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* loadCallerBot;
      const service = yield* BotService;
      const { bot, soul } = yield* service
        .get({ id: input.botId })
        .pipe(Effect.mapError(() => invalidRequest("Bot not found.")));
      return {
        bot: {
          id: bot.id,
          name: bot.name,
          role: bot.role,
          description: bot.description,
          providerInstanceId: bot.modelSelection.instanceId,
          model: bot.modelSelection.model,
          approvalMode: bot.approvalMode,
          avatar: bot.avatar,
          interactionMode: bot.interactionMode,
          canManageBots: bot.canManageBots,
          skills: bot.skills,
          soul,
          memoryBytes: bot.memoryBytes,
        },
      };
    }),
  ),
  create_bot: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const callerBot = yield* loadCallerBot;
      const denial = BotManagerPolicy.createDenial(callerBot, input);
      if (denial !== undefined) {
        return yield* invalidRequest(denial);
      }
      const service = yield* BotService;
      const modelSelection = yield* resolveModel(input.model, callerBot.modelSelection);
      const { bot } = yield* service
        .upsert({
          name: input.name,
          enabled: true,
          projectId: callerBot.projectId,
          workspaceStrategy: callerBot.workspaceStrategy,
          modelSelection,
          approvalMode: input.approvalMode ?? callerBot.approvalMode,
          soul: input.soul,
          canManageBots: false,
          role: input.role,
          description: input.description,
          avatar: input.avatar,
        })
        .pipe(Effect.mapError((error) => invalidRequest(error.message)));
      return { botId: bot.id };
    }),
  ),
  update_bot: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const callerBot = yield* loadCallerBot;
      const target = yield* loadTargetBot(input.botId);
      const denial = BotManagerPolicy.updateDenial(callerBot, target, input);
      if (denial !== undefined) {
        return yield* invalidRequest(denial);
      }
      const service = yield* BotService;
      const modelSelection = yield* resolveModel(input.model, target.modelSelection);
      yield* service
        .upsert({
          id: target.id,
          name: input.name ?? target.name,
          enabled: target.enabled,
          projectId: target.projectId,
          workspaceStrategy: target.workspaceStrategy,
          modelSelection,
          approvalMode: input.approvalMode ?? target.approvalMode,
          interactionMode: target.interactionMode,
          limits: target.limits,
          pinned: target.pinned,
          canManageBots: target.canManageBots,
          avatar: target.avatar,
          role: input.role !== undefined ? input.role : target.role,
          description: input.description !== undefined ? input.description : target.description,
          soul: input.soul,
        })
        .pipe(Effect.mapError((error) => invalidRequest(error.message)));
      return { botId: target.id };
    }),
  ),
  install_bot_skill: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const callerBot = yield* loadCallerBot;
      const target = yield* loadTargetBot(input.botId);
      const denial = BotManagerPolicy.installSkillDenial(callerBot, target);
      if (denial !== undefined) {
        return yield* invalidRequest(denial);
      }
      const { caller } = yield* loadCaller();
      const projectRoot = yield* callerProjectRoot(caller);
      const knownSkillPaths = yield* knownProviderSkillPaths;
      if (!skillSourceAllowed(input.sourcePath, projectRoot, knownSkillPaths)) {
        return yield* invalidRequest(
          "install_bot_skill only installs skills from your project folder or from skills this server already knows.",
        );
      }
      const service = yield* BotService;
      const { bot } = yield* service
        .installSkill({ id: target.id, sourcePath: input.sourcePath })
        .pipe(Effect.mapError((error) => invalidRequest(error.message)));
      return { botId: bot.id, skills: bot.skills.map((skill) => skill.name) };
    }),
  ),
  list_teams: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      yield* loadCallerBot;
      const teamService = yield* TeamService;
      const pipelineService = yield* PipelineService;
      const store = yield* BotStore;
      const { teams } = yield* teamService.list({});
      const { pipelines } = yield* pipelineService.list({});
      const { bots } = yield* store.list();
      const botById = new Map(bots.map((bot) => [bot.id, bot]));
      return {
        teams: teams.map((team) => ({
          id: team.id,
          name: team.name,
          ...(team.description === undefined ? {} : { description: team.description }),
          ...(team.leadBotId === undefined ? {} : { leadBotId: team.leadBotId }),
          members: team.memberBotIds
            .map((id) => botById.get(id))
            .filter((bot): bot is Bot => bot !== undefined)
            .map((bot) => ({
              id: bot.id,
              name: bot.name,
              ...(bot.role === undefined ? {} : { role: bot.role }),
            })),
          pipelines: pipelines
            .filter((pipeline) => pipeline.teamId === team.id)
            .map((pipeline) => ({
              id: pipeline.id,
              name: pipeline.name,
              ...(pipeline.description === undefined ? {} : { description: pipeline.description }),
              stages: pipeline.stages.map((stage) => ({
                id: stage.id,
                name: stage.name,
                botId: stage.botId,
                kind: stage.kind,
                ...(stage.onFail === undefined ? {} : { onFail: stage.onFail }),
              })),
              limits: pipeline.limits,
            })),
        })),
      };
    }),
  ),
  save_team: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const callerBot = yield* loadCallerBot;
      const teamService = yield* TeamService;
      const existing =
        input.id === undefined
          ? undefined
          : (yield* teamService.list({})).teams.find((team) => team.id === input.id);
      if (input.id !== undefined && existing === undefined) {
        return yield* invalidRequest(`Team "${input.id}" was not found.`);
      }
      const missing = [
        input.name === undefined ? "name" : undefined,
        input.memberBotIds === undefined ? "memberBotIds" : undefined,
      ].filter((field): field is string => field !== undefined);
      if (existing === undefined && missing.length > 0) {
        return yield* invalidRequest(
          `Creating a team needs ${missing.map((field) => `\`${field}\``).join(" and ")}.`,
        );
      }
      // A change can't touch a team that already holds a higher-approval bot,
      // and the resulting member list is checked the same way.
      if (existing !== undefined) {
        const denial = BotManagerPolicy.teamDenial(
          callerBot,
          yield* loadBots(existing.memberBotIds),
        );
        if (denial !== undefined) {
          return yield* invalidRequest(denial);
        }
      }
      const memberBotIds = input.memberBotIds ?? existing?.memberBotIds ?? [];
      const denial = BotManagerPolicy.teamDenial(callerBot, yield* loadBots(memberBotIds));
      if (denial !== undefined) {
        return yield* invalidRequest(denial);
      }
      const { team } = yield* teamService
        .upsert({
          id: input.id,
          name: input.name ?? existing!.name,
          description: input.description ?? existing?.description,
          leadBotId: input.leadBotId ?? existing?.leadBotId,
          memberBotIds,
        })
        .pipe(Effect.mapError((error) => invalidRequest(error.message)));
      return { teamId: team.id };
    }),
  ),
  save_pipeline: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const callerBot = yield* loadCallerBot;
      const pipelineService = yield* PipelineService;
      const existing =
        input.id === undefined
          ? undefined
          : (yield* pipelineService.list({})).pipelines.find(
              (pipeline) => pipeline.id === input.id,
            );
      if (input.id !== undefined && existing === undefined) {
        return yield* invalidRequest(`Pipeline "${input.id}" was not found.`);
      }
      const missing = [
        input.teamId === undefined ? "teamId" : undefined,
        input.name === undefined ? "name" : undefined,
        input.stages === undefined ? "stages" : undefined,
      ].filter((field): field is string => field !== undefined);
      if (existing === undefined && missing.length > 0) {
        return yield* invalidRequest(
          `Creating a pipeline needs ${missing.map((field) => `\`${field}\``).join(" and ")}.`,
        );
      }
      if (existing !== undefined) {
        const denial = BotManagerPolicy.pipelineDenial(
          callerBot,
          yield* stageBots(existing.stages),
        );
        if (denial !== undefined) {
          return yield* invalidRequest(denial);
        }
      }
      const stages = input.stages ?? existing?.stages ?? [];
      const denial = BotManagerPolicy.pipelineDenial(callerBot, yield* stageBots(stages));
      if (denial !== undefined) {
        return yield* invalidRequest(denial);
      }
      const { pipeline } = yield* pipelineService
        .upsert({
          id: input.id,
          teamId: input.teamId ?? existing!.teamId,
          name: input.name ?? existing!.name,
          description: input.description ?? existing?.description,
          stages,
          limits: input.limits ?? existing?.limits,
        })
        .pipe(Effect.mapError((error) => invalidRequest(error.message)));
      return { pipelineId: pipeline.id };
    }),
  ),
  run_pipeline: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* loadCallerBot;
      const context = yield* readCaller();
      const projectId = yield* resolveProjectId(context, input.projectId);
      const pipelineService = yield* PipelineService;
      const { runId } = yield* pipelineService
        .run({
          pipelineId: input.pipelineId,
          task: input.task,
          projectId,
          commandId: yield* newCommandId(),
          runtimeCeiling: context.limits.runtimeMode,
        })
        .pipe(Effect.mapError((error) => invalidRequest(error.message)));
      return { runId };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof BotsToolkit.tools>;

export const layer = McpToolAccess.toLayer(BotsToolkit, handlers);
