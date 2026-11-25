import type { AgentAwarenessThread } from "../orchestration-v2/ProjectionStore.ts";
import {
  isListedThreadLineage,
  TelegramRequestError,
  type TelegramChatSummary,
  type TelegramNotificationSettings,
  type ThreadId,
  type WorkflowRun,
  type WorkflowRunsSnapshot,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2, type AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  makeAgentAwarenessPublishWorker,
  shouldPublishAgentAwarenessEvent,
  snoozedCompletion,
} from "../relay/AgentAwarenessRelay.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import { TelegramBotApi, TelegramError } from "./TelegramBotApi.ts";
import * as Workflows from "../workflows/Workflows.ts";

const COMPLETION_CONFIRM_MS = 5_000;
const DETAIL_MAX_LENGTH = 300;
const NOT_CONFIGURED = "Telegram notifications are not set up";
const TEST_MESSAGE = "SimplyCode: Telegram notifications are set up.";
const isTelegramError = Schema.is(TelegramError);

export interface TelegramNotifyResult {
  readonly delivered: boolean;
  readonly reason?: string;
}

export class TelegramNotifier extends Context.Service<
  TelegramNotifier,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly sendTest: (input: {
      readonly botToken?: string;
      readonly chatId?: string;
    }) => Effect.Effect<void, TelegramRequestError>;
    readonly detectChats: (input: {
      readonly botToken?: string;
    }) => Effect.Effect<
      { readonly chats: ReadonlyArray<TelegramChatSummary> },
      TelegramRequestError
    >;
    readonly notify: (text: string) => Effect.Effect<TelegramNotifyResult>;
  }
>()("simplycode/notifications/TelegramNotifier") {}

const truncate = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const terminalWorkSinceStart = (
  thread: Pick<AgentAwarenessThread, "latestRunCompletedAt">,
  startedAt: number,
): boolean =>
  thread.latestRunCompletedAt != null &&
  DateTime.toEpochMillis(thread.latestRunCompletedAt) > startedAt;

const PHASE_PREFIX = {
  completed: "Done",
  failed: "Failed",
  waiting_for_approval: "Needs your approval",
  waiting_for_input: "Needs your input",
} as const;

const PHASE_SETTING = {
  completed: "notifyOnCompletion",
  failed: "notifyOnFailure",
  waiting_for_approval: "notifyOnApproval",
  waiting_for_input: "notifyOnInput",
} as const satisfies Record<string, keyof TelegramNotificationSettings>;

export interface TelegramNotificationDecision {
  /** Record so the next event projects the same identity it is skipped. */
  readonly identity: string;
  readonly action: "none" | "confirm" | "send";
  readonly message?: string;
}

const threadMessage = (state: AgentAwarenessState): string => {
  const prefix = PHASE_PREFIX[state.phase as keyof typeof PHASE_PREFIX] ?? state.headline;
  return [
    `SimplyCode · ${state.projectTitle}`,
    state.threadTitle,
    `${prefix}: ${state.headline}`,
    ...(state.detail === undefined ? [] : [truncate(state.detail, DETAIL_MAX_LENGTH)]),
    `Model: ${state.modelTitle}`,
  ].join("\n");
};

/**
 * What a thread's new projection means for the phone. `state` is the
 * awareness projection after snooze filtering; "confirm" asks the caller to
 * recheck the same identity a few seconds later before it sends.
 */
export function telegramNotificationFor(input: {
  readonly thread: Pick<
    AgentAwarenessThread,
    "latestRunId" | "latestRunCompletedAt" | "pendingRuntimeRequest"
  >;
  readonly state: AgentAwarenessState | null;
  readonly previousIdentity: string | undefined;
  readonly startedAt: number;
  readonly settings: Pick<
    TelegramNotificationSettings,
    "notifyOnCompletion" | "notifyOnFailure" | "notifyOnApproval" | "notifyOnInput"
  >;
}): TelegramNotificationDecision {
  const { thread, state, settings } = input;
  const identity =
    state === null
      ? "null"
      : `${state.phase}|${thread.latestRunId ?? ""}|${thread.pendingRuntimeRequest?.id ?? ""}`;
  if (identity === input.previousIdentity || state === null) {
    return { identity, action: "none" };
  }
  const phase = state.phase as keyof typeof PHASE_SETTING;
  const settingKey = PHASE_SETTING[phase];
  if (settingKey === undefined || settings[settingKey] !== true) {
    return { identity, action: "none" };
  }
  if (
    (phase === "completed" || phase === "failed") &&
    !terminalWorkSinceStart(thread, input.startedAt)
  ) {
    return { identity, action: "none" };
  }
  const message = threadMessage(state);
  // A run can end moments before its continuation starts; the caller confirms
  // the completion is still the current state before it sends.
  return phase === "completed"
    ? { identity, action: "confirm", message }
    : { identity, action: "send", message };
}

const WORKFLOW_STATUS_WORD = {
  completed: "passed",
  stopped: "failed",
  cancelled: "cancelled",
} as const;

const workflowIdentity = (run: WorkflowRun, questionNames: string): string =>
  `${run.status}|${run.detail ?? ""}|${questionNames}`;

/**
 * Runs that changed since the previous snapshot, with the message each earns.
 * `baseline` snapshots are recorded silently so the watcher does not burst on
 * start or when notifications come on.
 */
export function diffWorkflowRuns(input: {
  readonly previous: ReadonlyMap<string, string>;
  readonly snapshot: WorkflowRunsSnapshot;
  readonly baseline: boolean;
}): {
  readonly next: ReadonlyMap<string, string>;
  readonly messages: ReadonlyArray<string>;
} {
  const next = new Map(input.previous);
  const messages: string[] = [];
  for (const run of input.snapshot.runs) {
    const questions = input.snapshot.questions.filter((question) => question.runId === run.runId);
    const questionNames = questions
      .map((question) => question.name)
      .sort()
      .join(",");
    const identity = workflowIdentity(run, questionNames);
    if (input.previous.get(run.runId) === identity) continue;
    next.set(run.runId, identity);
    if (input.baseline) continue;
    const word = (WORKFLOW_STATUS_WORD as Record<string, string | undefined>)[run.status];
    let headline: string | null = null;
    if (word !== undefined) {
      headline = `Pipeline "${run.title}": ${word}`;
    } else if (run.status === "waiting" && questions.length > 0) {
      headline = `Pipeline "${run.title}": needs a decision`;
    }
    if (headline === null) continue;
    messages.push(
      [
        `SimplyCode`,
        headline,
        ...(run.detail === null ? [] : [truncate(run.detail, DETAIL_MAX_LENGTH)]),
      ].join("\n"),
    );
  }
  return { next, messages };
}

export const make = Effect.gen(function* () {
  const api = yield* TelegramBotApi;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const secretResolver = yield* SecretResolver.SecretResolver;
  const workflows = yield* Workflows.Workflows;
  const scope = yield* Effect.scope;
  const startedAt = (yield* DateTime.now).epochMilliseconds;

  const identityByThread = new Map<ThreadId, string>();
  const confirmDeadlines = new Map<
    ThreadId,
    { readonly identity: string; readonly deadline: number }
  >();
  const workflowKeysRef = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
  const workflowBaselineRef = yield* Ref.make(true);
  let scheduleConfirm: (threadId: ThreadId) => Effect.Effect<void> = () => Effect.void;

  const readCredentials = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() => new TelegramError({ message: NOT_CONFIGURED })),
    );
    const telegram = settings.telegramNotifications;
    if (!telegram.enabled) return null;
    const token = yield* requireSettingsSecret(secretResolver, telegram.botToken).pipe(
      Effect.orElseSucceed(() => ""),
    );
    if (token.trim() === "" || telegram.chatId.trim() === "") return null;
    return { token: token.trim(), chatId: telegram.chatId.trim() };
  });

  const deliver = Effect.fn("TelegramNotifier.deliver")(function* (text: string) {
    const credentials = yield* readCredentials;
    if (credentials === null) {
      return { delivered: false, reason: NOT_CONFIGURED } satisfies TelegramNotifyResult;
    }
    yield* api.sendMessage({
      token: Redacted.make(credentials.token),
      chatId: credentials.chatId,
      text,
    });
    return { delivered: true } satisfies TelegramNotifyResult;
  });

  const deliveryFailureDetail = (error: unknown) =>
    isTelegramError(error) ? error.message : String(error);

  const deliverQuietly = (text: string) =>
    deliver(text).pipe(
      Effect.catch((error) =>
        Effect.logWarning("telegram notification delivery failed", {
          detail: deliveryFailureDetail(error),
        }),
      ),
    );

  const readSettingsForRequest = serverSettings.getSettings.pipe(
    Effect.mapError(() => new TelegramRequestError({ message: NOT_CONFIGURED })),
  );

  const resolveToken = Effect.fn("TelegramNotifier.resolveToken")(function* (
    provided: string | undefined,
  ) {
    if (provided !== undefined && provided.trim() !== "" && provided !== SECRET_REDACTED) {
      return provided.trim();
    }
    const settings = yield* readSettingsForRequest;
    return yield* requireSettingsSecret(
      secretResolver,
      settings.telegramNotifications.botToken,
    ).pipe(Effect.mapError(() => new TelegramRequestError({ message: NOT_CONFIGURED })));
  });

  const sendTest: TelegramNotifier["Service"]["sendTest"] = Effect.fn("TelegramNotifier.sendTest")(
    function* (input) {
      const settings = yield* readSettingsForRequest;
      const token = yield* resolveToken(input.botToken);
      if (token.trim() === "") {
        return yield* new TelegramRequestError({
          message: "Save a bot token first, or paste one to test.",
        });
      }
      const chatId =
        input.chatId !== undefined && input.chatId.trim() !== ""
          ? input.chatId.trim()
          : settings.telegramNotifications.chatId.trim();
      if (chatId === "") {
        return yield* new TelegramRequestError({
          message: "Set a chat ID first, or use Detect to pick one.",
        });
      }
      yield* api
        .sendMessage({ token: Redacted.make(token), chatId, text: TEST_MESSAGE })
        .pipe(Effect.mapError((error) => new TelegramRequestError({ message: error.message })));
    },
  );

  const detectChats: TelegramNotifier["Service"]["detectChats"] = Effect.fn(
    "TelegramNotifier.detectChats",
  )(function* (input) {
    const token = yield* resolveToken(input.botToken);
    if (token.trim() === "") {
      return yield* new TelegramRequestError({
        message: "Save a bot token first, or paste one to detect chats.",
      });
    }
    const chats = yield* api
      .listChats({ token: Redacted.make(token) })
      .pipe(Effect.mapError((error) => new TelegramRequestError({ message: error.message })));
    return { chats };
  });

  const notify: TelegramNotifier["Service"]["notify"] = Effect.fn("TelegramNotifier.notify")(
    function* (text) {
      const result = yield* deliver(text).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            delivered: false,
            reason: deliveryFailureDetail(error),
          } satisfies TelegramNotifyResult),
        ),
      );
      return result;
    },
  );

  const readAwarenessThread = (threadId: ThreadId) =>
    threads
      .getAgentAwarenessSnapshot(threadId)
      .pipe(Effect.map((snapshot) => snapshot.threads[0] ?? null));

  const processThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    const credentials = yield* readCredentials;
    if (credentials === null) return;
    const threadShell = yield* readAwarenessThread(threadId);
    if (
      threadShell === null ||
      threadShell.archivedAt !== null ||
      !isListedThreadLineage(threadShell.lineage)
    ) {
      confirmDeadlines.delete(threadId);
      return;
    }
    const project = yield* projects.getById(threadShell.projectId);
    if (Option.isNone(project)) return;
    const environmentId = yield* serverEnvironment.getEnvironmentId;
    const projected = projectThreadAwarenessV2({
      environmentId,
      project: project.value,
      thread: threadShell,
    });
    const state = snoozedCompletion(threadShell, projected) ? null : projected;
    const settings = yield* serverSettings.getSettings;
    const decision = telegramNotificationFor({
      thread: threadShell,
      state,
      previousIdentity: identityByThread.get(threadId),
      startedAt,
      settings: settings.telegramNotifications,
    });
    if (decision.action === "confirm") {
      const now = (yield* DateTime.now).epochMilliseconds;
      const pending = confirmDeadlines.get(threadId);
      if (pending !== undefined && pending.identity === decision.identity) {
        if (now < pending.deadline) return;
        confirmDeadlines.delete(threadId);
        identityByThread.set(threadId, decision.identity);
        yield* deliverQuietly(decision.message!);
        return;
      }
      confirmDeadlines.set(threadId, {
        identity: decision.identity,
        deadline: now + COMPLETION_CONFIRM_MS,
      });
      yield* scheduleConfirm(threadId);
      return;
    }
    confirmDeadlines.delete(threadId);
    identityByThread.set(threadId, decision.identity);
    if (decision.action === "send" && decision.message !== undefined) {
      yield* deliverQuietly(decision.message);
    }
  });

  const processThreadGuarded = (threadId: ThreadId) =>
    processThread(threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logWarning("telegram notification check failed", {
              threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const worker = yield* makeAgentAwarenessPublishWorker(processThreadGuarded);

  scheduleConfirm = (threadId) =>
    Effect.forkIn(
      Effect.sleep("5 seconds").pipe(
        Effect.andThen(worker.enqueue(threadId)),
        Effect.catchCause((cause) =>
          Effect.logWarning("telegram completion confirmation failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
        ),
      ),
      scope,
    ).pipe(Effect.asVoid);

  const handleWorkflowSnapshot = Effect.fnUntraced(function* (snapshot: WorkflowRunsSnapshot) {
    const baseline = yield* Ref.get(workflowBaselineRef);
    const previous = yield* Ref.get(workflowKeysRef);
    const { next, messages } = diffWorkflowRuns({ previous, snapshot, baseline });
    yield* Ref.set(workflowKeysRef, next);
    if (baseline) {
      yield* Ref.set(workflowBaselineRef, false);
      return;
    }
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings === null || !settings.telegramNotifications.notifyOnWorkflows) return;
    for (const message of messages) {
      yield* deliverQuietly(message);
    }
  });

  const start: TelegramNotifier["Service"]["start"] = Effect.fn("TelegramNotifier.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(threads.streamDomainEvents, (event) =>
          shouldPublishAgentAwarenessEvent(event) ? worker.enqueue(event.threadId) : Effect.void,
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("telegram thread notification stream ended", {
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      );
      yield* forkParked(
        Stream.runForEach(workflows.watch, handleWorkflowSnapshot).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("telegram workflow notification stream ended", {
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      );
    },
  );

  return TelegramNotifier.of({ start, sendTest, detectChats, notify });
});

export const layer = Layer.effect(TelegramNotifier, make);
