// Imports bots from other apps and exports SimplyCode bots as a single JSON
// package. Scanning is stateless: apply rescans the source, so a package's
// content travels with both calls. One failed bot never stops the rest; its
// error lands in the result's warnings.
import {
  BotError,
  normalizeBotSkillName,
  type Bot,
  type BotExportInput,
  type BotExportResult,
  type BotImportApplyInput,
  type BotImportApplyResult,
  type BotImportCandidate,
  type BotImportScanInput,
  type BotImportScanResult,
  BotProfile,
  botRuntimeMode,
  type ModelSelection,
  type ProjectId,
  type ScheduledTaskUpsertSchedule,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as NodeUtil from "node:util";

import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ScheduledTasks from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import { BotStore } from "../BotStore.ts";
import { scanSource, type ScannedBot } from "./sources.ts";

const decodeProfile = Schema.decodeUnknownEffect(BotProfile);
const utf8Decoder = new NodeUtil.TextDecoder("utf-8", { fatal: true });

const serializePackage = (bots: ReadonlyArray<unknown>, exportedAt: string): string =>
  JSON.stringify({ format: "simplycode-bots", version: 1, exportedAt, bots }, null, 2);

function botError(message: string, input?: { cause?: unknown }) {
  return new BotError({
    message,
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

// The source's provider maps to the instance whose id or driver matches it
// (case-insensitive); the model must be one of that instance's known slugs.
const mapModel = (
  bot: ScannedBot,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | undefined => {
  if (bot.sourceModelSlug === undefined || bot.sourceProvider === undefined) return undefined;
  const wanted = bot.sourceProvider.toLowerCase();
  for (const provider of providers) {
    const matchesInstance =
      provider.instanceId.toLowerCase() === wanted || provider.driver.toLowerCase() === wanted;
    if (!matchesInstance) continue;
    const model = provider.models.find((entry) => entry.slug === bot.sourceModelSlug);
    if (model !== undefined) {
      return { instanceId: provider.instanceId, model: model.slug };
    }
  }
  return undefined;
};

const toCandidate = (bot: ScannedBot, providers: ReadonlyArray<ServerProvider>) => {
  const modelSelection = mapModel(bot, providers);
  return {
    key: bot.key,
    name: bot.name,
    ...(bot.role === undefined ? {} : { role: bot.role }),
    ...(bot.description === undefined ? {} : { description: bot.description }),
    ...(bot.avatar === undefined ? {} : { avatar: bot.avatar }),
    ...(bot.sourceModel === undefined ? {} : { sourceModel: bot.sourceModel }),
    ...(modelSelection === undefined ? {} : { modelSelection }),
    approvalMode: bot.approvalMode,
    soulBytes: Buffer.byteLength(bot.soul, "utf8"),
    memoryBytes: Buffer.byteLength(bot.memory, "utf8"),
    skills: bot.skills.map((skill) => skill.name),
    automations: bot.automations.map((automation) => ({
      name: automation.name,
      scheduleLabel: automation.scheduleLabel,
      importable: automation.importable,
    })),
    warnings: bot.warnings,
  } satisfies BotImportCandidate;
};

export class BotImportService extends Context.Service<
  BotImportService,
  {
    readonly scan: (input: BotImportScanInput) => Effect.Effect<BotImportScanResult, BotError>;
    readonly apply: (input: BotImportApplyInput) => Effect.Effect<BotImportApplyResult, BotError>;
    readonly exportBots: (input: BotExportInput) => Effect.Effect<BotExportResult, BotError>;
  }
>()("simplycode/bots/import/BotImportService") {}

export const layer = Layer.effect(
  BotImportService,
  Effect.gen(function* () {
    const store = yield* BotStore;
    const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const projectStore = yield* ProjectStore.ProjectStoreV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const scanned = Effect.fnUntraced(function* (source: BotImportScanInput["source"]) {
      return yield* scanSource(source).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError((cause) =>
          botError(cause.message ?? "Could not read the import source.", { cause }),
        ),
      );
    });

    const providers = Effect.fnUntraced(function* () {
      return yield* registry.getProviders.pipe(
        Effect.mapError((cause) => botError("Could not list providers.", { cause })),
      );
    });

    const requireProject = Effect.fnUntraced(function* (projectId: ProjectId) {
      const project = yield* projectStore
        .get(projectId)
        .pipe(Effect.mapError((cause) => botError("Could not load the project.", { cause })));
      if (Option.isNone(project)) {
        return yield* botError("Project not found.");
      }
    });

    const scan: BotImportService["Service"]["scan"] = Effect.fn("BotImportService.scan")(
      function* (input) {
        const result = yield* scanned(input.source);
        const providerList = yield* providers();
        return {
          sourceLabel: result.sourceLabel,
          candidates: result.bots.map((bot) => toCandidate(bot, providerList)),
          warnings: result.warnings,
        };
      },
    );

    const importBot = Effect.fnUntraced(function* (
      bot: ScannedBot,
      input: BotImportApplyInput,
      providerList: ReadonlyArray<ServerProvider>,
      warnings: string[],
    ) {
      const id = yield* store
        .allocateId(bot.name)
        .pipe(Effect.mapError((cause) => botError("Could not allocate a bot id.", { cause })));
      const now = DateTime.formatIso(yield* DateTime.now);
      const profile: BotProfile = {
        id,
        name: bot.name,
        enabled: true,
        pinned: false,
        projectId: input.projectId,
        workspaceStrategy: { type: "root" },
        modelSelection: mapModel(bot, providerList) ?? input.fallbackModelSelection,
        approvalMode: bot.approvalMode,
        interactionMode: bot.interactionMode ?? "default",
        limits: bot.limits ?? {},
        createdAt: now,
        updatedAt: now,
        ...(bot.avatar === undefined ? {} : { avatar: bot.avatar }),
        ...(bot.role === undefined ? {} : { role: bot.role }),
        ...(bot.description === undefined ? {} : { description: bot.description }),
      };
      // Reject profiles the schema would not read back, rather than write a
      // bot that only shows up as a load error.
      const validProfile = yield* decodeProfile(profile).pipe(
        Effect.mapError((cause) => botError("The bot profile is invalid.", { cause })),
      );
      const written = yield* store.write(
        validProfile,
        bot.soul.length > 0 ? bot.soul : undefined,
        undefined,
      );
      if (input.include.memory && bot.memory.length > 0) {
        yield* store.writeMemory(written.id, bot.memory);
      }
      if (input.include.skills) {
        for (const skill of bot.skills) {
          const name = normalizeBotSkillName(skill.name);
          if (name === undefined) {
            warnings.push(`"${bot.name}": skill "${skill.name}" is not a valid skill name.`);
            continue;
          }
          const installed = yield* store
            .installSkillFiles(written.id, name, skill.files)
            .pipe(Effect.result);
          if (Result.isFailure(installed)) {
            warnings.push(`"${bot.name}": ${installed.failure.message}`);
          }
        }
      }
      if (input.include.automations) {
        for (const automation of bot.automations) {
          if (!automation.importable || automation.schedule === undefined) continue;
          const schedule: ScheduledTaskUpsertSchedule = automation.schedule;
          const created = yield* scheduledTasks
            .upsert({
              title: automation.name,
              prompt: automation.prompt,
              // Imported routines are always created disabled.
              enabled: false,
              schedule,
              projectId: input.projectId,
              botId: written.id,
              workspaceStrategy: { type: "root" },
              modelSelection: written.modelSelection,
              runtimeMode: botRuntimeMode(written.approvalMode),
              interactionMode: written.interactionMode,
            })
            .pipe(Effect.result);
          if (Result.isFailure(created)) {
            warnings.push(
              `"${bot.name}": routine "${automation.name}" could not be imported: ${created.failure.message}`,
            );
          }
        }
      }
      return written;
    });

    const apply: BotImportService["Service"]["apply"] = Effect.fn("BotImportService.apply")(
      function* (input) {
        yield* requireProject(input.projectId);
        const result = yield* scanned(input.source);
        const providerList = yield* providers();
        const byKey = new Map(result.bots.map((bot) => [bot.key, bot]));
        const warnings = [...result.warnings];
        const bots: Bot[] = [];
        for (const key of input.keys) {
          const bot = byKey.get(key);
          if (bot === undefined) {
            warnings.push(`A candidate is no longer in the source and was skipped.`);
            continue;
          }
          warnings.push(...bot.warnings);
          const imported = yield* importBot(bot, input, providerList, warnings).pipe(Effect.result);
          if (Result.isFailure(imported)) {
            warnings.push(`"${bot.name}" could not be imported: ${imported.failure.message}`);
            continue;
          }
          bots.push(imported.success);
        }
        return { bots, warnings };
      },
    );

    const readSkillFiles = Effect.fnUntraced(function* (dir: string) {
      const files: { path: string; data: Uint8Array }[] = [];
      const pending = [dir];
      while (pending.length > 0) {
        const current = pending.pop()!;
        const entries = yield* fileSystem.readDirectory(current);
        for (const entry of entries) {
          const full = path.join(current, entry);
          const info = yield* fileSystem.lstat(full);
          if (info.type === "Directory") {
            pending.push(full);
          } else if (info.type === "File") {
            const data = yield* fileSystem.readFile(full);
            files.push({ path: path.relative(dir, full).split(path.sep).join("/"), data });
          }
        }
      }
      return files;
    });

    const exportBots: BotImportService["Service"]["exportBots"] = Effect.fn(
      "BotImportService.exportBots",
    )(function* (input) {
      const { tasks } = yield* scheduledTasks
        .list()
        .pipe(Effect.mapError((cause) => botError("Could not list scheduled tasks.", { cause })));
      const exportedBots: unknown[] = [];
      for (const id of input.ids) {
        const { bot, soul, memory, skills } = yield* store.get(id);
        const skillEntries: unknown[] = [];
        for (const skill of skills) {
          const dir = path.dirname(skill.path);
          const files = yield* readSkillFiles(dir).pipe(
            Effect.mapError((cause) =>
              botError(`Could not read the skill "${skill.name}".`, { cause }),
            ),
          );
          skillEntries.push({
            name: skill.name,
            files: files.map((file) => {
              try {
                return { path: file.path, text: utf8Decoder.decode(file.data) };
              } catch {
                return { path: file.path, base64: Buffer.from(file.data).toString("base64") };
              }
            }),
          });
        }
        const automations = tasks
          .filter(
            (task) =>
              task.botId === id &&
              (task.schedule.type === "interval" ||
                task.schedule.type === "fixed_time" ||
                task.schedule.type === "once"),
          )
          .map((task) => ({ name: task.title, prompt: task.prompt, schedule: task.schedule }));
        // Webhook automations are skipped: their secrets never leave the server.
        const {
          id: _id,
          projectId: _projectId,
          enabled: _enabled,
          pinned: _pinned,
          createdAt: _createdAt,
          updatedAt: _updatedAt,
          soulBytes: _soulBytes,
          memoryBytes: _memoryBytes,
          skills: _skills,
          threadTag: _threadTag,
          ...profile
        } = bot;
        exportedBots.push({
          profile,
          soul,
          ...(input.includeMemory ? { memory } : {}),
          skills: skillEntries,
          automations,
        });
      }
      const fileName =
        input.ids.length === 1
          ? `${input.ids[0]}.simplycode-bots.json`
          : `simplycode-bots-${DateTime.formatIso(yield* DateTime.now).slice(0, 10)}.simplycode-bots.json`;
      return {
        fileName,
        content: serializePackage(exportedBots, DateTime.formatIso(yield* DateTime.now)),
      };
    });

    return BotImportService.of({ scan, apply, exportBots });
  }),
);
