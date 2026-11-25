import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  isListedThreadLineage,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PendingRuntimeRequestSummary,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  TelegramRequestError,
  ThreadId,
  type WorkflowQuestion,
  type WorkflowRun,
  type WorkflowRunsSnapshot,
} from "@t3tools/contracts";
import type { AgentAwarenessState } from "@t3tools/shared/agentAwareness";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { snoozedCompletion } from "../relay/AgentAwarenessRelay.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Workflows from "../workflows/Workflows.ts";
import { TelegramBotApi } from "./TelegramBotApi.ts";
import {
  diffWorkflowRuns,
  make as makeTelegramNotifier,
  telegramNotificationFor,
} from "./TelegramNotifier.ts";

const THREAD_ID = ThreadId.make("telegram-thread");
const PROJECT_ID = ProjectId.make("telegram-project");
const PROVIDER = ProviderInstanceId.make("codex");
const RUN_ID = RunId.make("run-1");
const NOW = "2026-09-04T12:00:00.000Z";
const NOW_DT = DateTime.makeUnsafe(NOW);
const STARTED_AT = DateTime.toEpochMillis(NOW_DT);
const AFTER_START = DateTime.makeUnsafe("2026-09-04T12:00:10.000Z");
const BEFORE_START = DateTime.makeUnsafe("2026-09-04T11:00:00.000Z");

const SETTINGS_ALL_ON = {
  notifyOnCompletion: true,
  notifyOnFailure: true,
  notifyOnApproval: true,
  notifyOnInput: true,
};

function state(
  phase: AgentAwarenessState["phase"],
  patch: Partial<AgentAwarenessState> = {},
): AgentAwarenessState {
  return {
    environmentId: EnvironmentId.make("env-1"),
    threadId: THREAD_ID,
    projectTitle: "Project",
    threadTitle: "Fix the bug",
    phase,
    headline: `headline:${phase}`,
    modelTitle: "test-model",
    updatedAt: NOW,
    deepLink: "/threads/env-1/telegram-thread",
    ...patch,
  };
}

const decisionThread = (
  patch: Partial<{
    latestRunId: RunId | null;
    latestRunCompletedAt: DateTime.Utc | null;
    pendingRuntimeRequest: OrchestrationV2PendingRuntimeRequestSummary | null;
  }> = {},
) => ({
  latestRunId: RUN_ID,
  latestRunCompletedAt: AFTER_START,
  pendingRuntimeRequest: null,
  ...patch,
});

const decide = (
  phase: AgentAwarenessState["phase"],
  settings: typeof SETTINGS_ALL_ON = SETTINGS_ALL_ON,
  thread = decisionThread(),
  previousIdentity?: string,
) =>
  telegramNotificationFor({
    thread,
    state: state(phase),
    previousIdentity,
    startedAt: STARTED_AT,
    settings,
  });

describe("telegramNotificationFor", () => {
  it("asks to confirm a completion before sending", () => {
    const decision = decide("completed");
    assert.equal(decision.action, "confirm");
    assert.include(decision.message, "SimplyCode · Project");
    assert.include(decision.message, "Fix the bug");
    assert.include(decision.message, "Done:");
    assert.include(decision.message, "Model: test-model");
  });

  it("sends immediately for a failure", () => {
    const decision = decide("failed");
    assert.equal(decision.action, "send");
    assert.include(decision.message, "Failed:");
  });

  it("sends immediately for an approval wait", () => {
    const decision = decide("waiting_for_approval");
    assert.equal(decision.action, "send");
    assert.include(decision.message, "Needs your approval:");
  });

  it("sends immediately for an input wait", () => {
    const decision = decide("waiting_for_input");
    assert.equal(decision.action, "send");
    assert.include(decision.message, "Needs your input:");
  });

  it("says nothing when the matching switch is off but still records the identity", () => {
    for (const [phase, settings] of [
      ["completed", { ...SETTINGS_ALL_ON, notifyOnCompletion: false }],
      ["failed", { ...SETTINGS_ALL_ON, notifyOnFailure: false }],
      ["waiting_for_approval", { ...SETTINGS_ALL_ON, notifyOnApproval: false }],
      ["waiting_for_input", { ...SETTINGS_ALL_ON, notifyOnInput: false }],
    ] as const) {
      const decision = decide(phase, settings);
      assert.equal(decision.action, "none", phase);
      assert.notEqual(decision.identity, "null", phase);
    }
  });

  it("says nothing for phases without a message but still records the identity", () => {
    for (const phase of ["starting", "running", "stale"] as const) {
      const decision = decide(phase);
      assert.equal(decision.action, "none", phase);
      assert.notEqual(decision.identity, "null", phase);
    }
  });

  it("says nothing for a repeat of the same identity", () => {
    const first = decide("failed");
    assert.equal(first.action, "send");
    const repeat = decide("failed", SETTINGS_ALL_ON, decisionThread(), first.identity);
    assert.equal(repeat.action, "none");
    assert.equal(repeat.identity, first.identity);
  });

  it("alerts again when a new request arrives behind the same phase", () => {
    const request = (id: string) =>
      ({
        id: RuntimeRequestId.make(id),
        kind: "command",
        createdAt: NOW_DT,
      }) as OrchestrationV2PendingRuntimeRequestSummary;
    const first = decide(
      "waiting_for_approval",
      SETTINGS_ALL_ON,
      decisionThread({ pendingRuntimeRequest: request("request-1") }),
    );
    assert.equal(first.action, "send");
    const second = decide(
      "waiting_for_approval",
      SETTINGS_ALL_ON,
      decisionThread({ pendingRuntimeRequest: request("request-2") }),
      first.identity,
    );
    assert.equal(second.action, "send");
    assert.notEqual(second.identity, first.identity);
  });

  it("ignores completions and failures that ended before the service started", () => {
    const old = decisionThread({ latestRunCompletedAt: BEFORE_START });
    assert.equal(decide("completed", SETTINGS_ALL_ON, old).action, "none");
    assert.equal(decide("failed", SETTINGS_ALL_ON, old).action, "none");
    // Waits are not gated on run completion time.
    assert.equal(decide("waiting_for_approval", SETTINGS_ALL_ON, old).action, "send");
  });

  it("says nothing when the projection is suppressed, such as a snoozed completion", () => {
    const decision = telegramNotificationFor({
      thread: decisionThread(),
      state: null,
      previousIdentity: "running|run-1|",
      startedAt: STARTED_AT,
      settings: SETTINGS_ALL_ON,
    });
    assert.deepEqual(decision, { identity: "null", action: "none" });
  });
});

const shell = (
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Thread",
  providerInstanceId: PROVIDER,
  modelSelection: { instanceId: PROVIDER, model: "test-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  activeRunId: null,
  latestVisibleMessage: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  lastVisitedAt: null,
  deletedAt: null,
  branch: null,
  linkedPullRequest: null,
  status: "completed",
  activityRunStatus: null,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  latestRunId: RUN_ID,
  latestRunRequestedAt: null,
  latestRunStartedAt: null,
  latestRunCompletedAt: AFTER_START,
  latestUserMessageAt: null,
  createdAt: NOW_DT,
  updatedAt: NOW_DT,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  pinnedAt: null,
  ...overrides,
});

describe("notification gates the notifier applies", () => {
  it("marks a completion inside a snooze window as snoozed, then suppresses it", () => {
    const thread = shell({
      latestRunCompletedAt: AFTER_START,
      snoozedAt: NOW_DT,
      snoozedUntil: DateTime.makeUnsafe("2026-09-04T13:00:00.000Z"),
    });
    assert.isTrue(snoozedCompletion(thread, { phase: "completed" }));
    // The notifier maps a snoozed completion to a suppressed projection.
    const decision = telegramNotificationFor({
      thread,
      state: snoozedCompletion(thread, state("completed")) ? null : state("completed"),
      previousIdentity: undefined,
      startedAt: STARTED_AT,
      settings: SETTINGS_ALL_ON,
    });
    assert.deepEqual(decision, { identity: "null", action: "none" });
  });

  it("only lists top-level threads, never subagents, side chats, or workflow steps", () => {
    const base = shell().lineage;
    assert.isTrue(isListedThreadLineage(base));
    assert.isFalse(
      isListedThreadLineage({
        ...base,
        parentThreadId: THREAD_ID,
        relationshipToParent: "subagent",
      }),
    );
    assert.isFalse(isListedThreadLineage({ ...base, sideChat: true }));
    assert.isFalse(isListedThreadLineage({ ...base, workflowStep: true }));
  });
});

const workflowRun = (patch: Partial<WorkflowRun> = {}): WorkflowRun => ({
  runId: "run-1",
  workflow: "deploy",
  key: null,
  version: 1,
  title: "Deploy",
  status: "running",
  detail: null,
  result: null,
  pauses: 0,
  retired: false,
  resumesAt: null,
  parentRunId: null,
  parentStep: null,
  startedAt: NOW,
  updatedAt: NOW,
  endedAt: null,
  ...patch,
});

const snapshot = (
  runs: ReadonlyArray<WorkflowRun>,
  questions: ReadonlyArray<WorkflowQuestion> = [],
): WorkflowRunsSnapshot => ({ workflows: [], runs, questions });

describe("diffWorkflowRuns", () => {
  it("records the first snapshot silently", () => {
    const { next, messages } = diffWorkflowRuns({
      previous: new Map(),
      snapshot: snapshot([workflowRun({ status: "completed" })]),
      baseline: true,
    });
    assert.lengthOf(messages, 0);
    assert.isTrue(next.has("run-1"));
    const again = diffWorkflowRuns({
      previous: next,
      snapshot: snapshot([workflowRun({ status: "completed" })]),
      baseline: false,
    });
    assert.lengthOf(again.messages, 0);
  });

  it("sends once when a run reaches a terminal status", () => {
    const running = diffWorkflowRuns({
      previous: new Map(),
      snapshot: snapshot([workflowRun({ status: "running" })]),
      baseline: false,
    });
    assert.lengthOf(running.messages, 0);
    const done = diffWorkflowRuns({
      previous: running.next,
      snapshot: snapshot([workflowRun({ status: "completed" })]),
      baseline: false,
    });
    assert.lengthOf(done.messages, 1);
    assert.include(done.messages[0]!, 'Pipeline "Deploy": passed');
    const repeat = diffWorkflowRuns({
      previous: done.next,
      snapshot: snapshot([workflowRun({ status: "completed" })]),
      baseline: false,
    });
    assert.lengthOf(repeat.messages, 0);
  });

  it("reports a stopped run as failed and a cancelled run as cancelled", () => {
    const base = diffWorkflowRuns({
      previous: new Map(),
      snapshot: snapshot([workflowRun()]),
      baseline: true,
    });
    const stopped = diffWorkflowRuns({
      previous: base.next,
      snapshot: snapshot([workflowRun({ status: "stopped", detail: "step blew up" })]),
      baseline: false,
    });
    assert.include(stopped.messages[0]!, 'Pipeline "Deploy": failed');
    assert.include(stopped.messages[0]!, "step blew up");
    const cancelled = diffWorkflowRuns({
      previous: base.next,
      snapshot: snapshot([workflowRun({ status: "cancelled" })]),
      baseline: false,
    });
    assert.include(cancelled.messages[0]!, 'Pipeline "Deploy": cancelled');
  });

  it("reports a waiting run with an open question, once", () => {
    const question: WorkflowQuestion = {
      runId: "run-1",
      name: "ship-it",
      request: { title: "Ship?" },
      askedAt: NOW,
      thread: null,
    };
    const waiting = diffWorkflowRuns({
      previous: new Map(),
      snapshot: snapshot([workflowRun({ status: "waiting" })], [question]),
      baseline: false,
    });
    assert.lengthOf(waiting.messages, 1);
    assert.include(waiting.messages[0]!, 'Pipeline "Deploy": needs a decision');
    const repeat = diffWorkflowRuns({
      previous: waiting.next,
      snapshot: snapshot([workflowRun({ status: "waiting" })], [question]),
      baseline: false,
    });
    assert.lengthOf(repeat.messages, 0);
  });

  it("says nothing for a waiting run without a question", () => {
    const { messages, next } = diffWorkflowRuns({
      previous: new Map(),
      snapshot: snapshot([workflowRun({ status: "waiting" })]),
      baseline: false,
    });
    assert.lengthOf(messages, 0);
    assert.isTrue(next.has("run-1"));
  });
});

const unused = () => Effect.die("Unexpected test dependency call");

const TELEGRAM_SETTINGS = {
  enabled: true,
  botToken: "token-1",
  chatId: "42",
};

const RUN_PAYLOAD = {
  id: RUN_ID,
  threadId: THREAD_ID,
  ordinal: 1,
  providerInstanceId: PROVIDER,
  modelSelection: { instanceId: PROVIDER, model: "test-model" },
  providerThreadId: null,
  userMessageId: MessageId.make("message-1"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: NOW_DT,
  startedAt: NOW_DT,
  completedAt: NOW_DT,
  checkpointId: null,
  contextHandoffId: null,
} satisfies OrchestrationV2Run;

const runEvent = (id: string): OrchestrationV2DomainEvent => ({
  id: EventId.make(id),
  type: "run.updated",
  threadId: THREAD_ID,
  runId: RUN_ID,
  occurredAt: NOW_DT,
  payload: RUN_PAYLOAD,
});

interface SentMessage {
  readonly chatId: string;
  readonly text: string;
}

const makeTestNotifier = Effect.fnUntraced(function* (options: {
  readonly sentMessages: Array<SentMessage>;
  readonly readShell: () => OrchestrationV2ThreadShell | null;
  readonly telegramSettings?: Partial<typeof TELEGRAM_SETTINGS & { notifyOnWorkflows: boolean }>;
  readonly domainEvents?: Stream.Stream<OrchestrationV2DomainEvent>;
  readonly watch?: Stream.Stream<WorkflowRunsSnapshot>;
  readonly snapshotReads?: Queue.Queue<void>;
  readonly sentQueue?: Queue.Queue<SentMessage>;
  readonly chats?: ReadonlyArray<{ id: string; title: string; type: string }>;
}) {
  const api = TelegramBotApi.of({
    sendMessage: (input) =>
      Effect.gen(function* () {
        const message = { chatId: input.chatId, text: input.text };
        options.sentMessages.push(message);
        if (options.sentQueue !== undefined) {
          yield* Queue.offer(options.sentQueue, message);
        }
      }),
    listChats: () => Effect.succeed(options.chats ?? []),
  });
  const threads = ThreadManagementService.ThreadManagementService.of({
    getThreadShell: unused,
    getShellSnapshot: unused,
    getAgentAwarenessSnapshot: () =>
      (options.snapshotReads === undefined
        ? Effect.void
        : Queue.offer(options.snapshotReads, undefined)
      ).pipe(
        Effect.andThen(
          Effect.sync(() => ({
            snapshotSequence: 1,
            threads: options.readShell() === null ? [] : [options.readShell()!],
          })),
        ),
      ),
    listActiveSubagentThreadIds: unused,
    listAppOwnedChildThreadIds: unused,
    countThreads: unused,
    listActiveShellIndex: () => Effect.succeed([]),
    listOlderSettledThreads: unused,
    readShellSnapshot: unused,
    getThreadTitles: unused,
    getThreadLinkMetadata: unused,
    ensureLegacyTranscript: unused,
    dispatch: unused,
    searchThread: () => Effect.die("unused"),
    searchThreadStream: () => Stream.empty,
    getThreadHistoryPage: () => Effect.die("unused"),
    getTimelinePage: () => Effect.die("Unused timeline read"),
    getMessageCount: () => Effect.die("unused"),
    getRunCount: () => Effect.die("unused run count"),
    getMessagesById: () => Effect.die("unused messages by id"),
    getTurnItem: () => Effect.die("unused turn item read"),
    getThreadRecords: () => Effect.die("unused record read"),
    getThreadProjection: unused,
    getCheckpointContext: unused,
    getThreadSnapshot: unused,
    getThreadTranscript: unused,
    getThreadSnapshotWindow: unused,
    getProjectThreadRecords: () => Effect.die("unused project record read"),
    listProjectThreads: unused,
    sendToThread: unused,
    submitRunOutput: unused,
    assertProviderInstanceEnabled: unused,
    isProviderInstanceEnabledForProject: unused,
    hasReceipt: unused,
    waitForThread: unused,
    settleAfterRun: unused,
    settleThread: unused,
    interruptThread: unused,
    stopWorkflow: () => Effect.die("unused stopWorkflow"),
    forceStopThread: () => Effect.die("unused forceStopThread"),
    awaitBackgroundTasks: unused,
    stopDelegatedTasks: unused,
    getThreadEventSequence: unused,
    recoverDelegatedTask: unused,
    cancelDelegatedTask: unused,
    delegatedTaskResultPending: unused,
    streamStoredEvents: Stream.empty,
    streamStoredEventsFrom: () => Stream.empty,
    streamDomainEvents: options.domainEvents ?? Stream.empty,
  });
  const project = {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace",
    defaultModelSelection: null,
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
  return yield* makeTelegramNotifier.pipe(
    Effect.provideService(TelegramBotApi, api),
    Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
    Effect.provideService(ProjectService.ProjectService, {
      create: unused,
      bootstrap: unused,
      update: unused,
      delete: unused,
      getByWorkspaceRoot: unused,
      workspaceScanDirectory: unused,
      snapshot: Effect.succeed({ projects: [project], updatedAt: NOW }),
      listPage: unused,
      getShell: unused,
      listShells: unused,
      getById: () => Effect.succeedSome(project),
    }),
    Effect.provideService(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
      getDescriptor: unused(),
    }),
    Effect.provideService(
      SecretResolver.SecretResolver,
      SecretResolver.SecretResolver.of({
        read: unused,
        invalidate: unused,
        label: unused,
      }),
    ),
    Effect.provideService(Workflows.Workflows, {
      ...Workflows.disabled,
      watch: options.watch ?? Stream.empty,
    }),
    Effect.provide(
      ServerSettings.ServerSettingsService.layerTest({
        telegramNotifications: {
          ...TELEGRAM_SETTINGS,
          notifyOnCompletion: true,
          notifyOnFailure: true,
          notifyOnApproval: true,
          notifyOnInput: true,
          notifyOnWorkflows: true,
          ...options.telegramSettings,
        },
      }),
    ),
  );
});

describe("TelegramNotifier", () => {
  it.effect("reports not-configured when notifications are off", () =>
    Effect.gen(function* () {
      const sentMessages: Array<SentMessage> = [];
      const notifier = yield* makeTestNotifier({
        sentMessages,
        telegramSettings: { enabled: false },
        readShell: () => null,
      });
      const result = yield* notifier.notify("hello");
      assert.deepEqual(result, {
        delivered: false,
        reason: "Telegram notifications are not set up",
      });
      assert.lengthOf(sentMessages, 0);
    }),
  );

  it.effect("delivers notify through the saved credentials", () =>
    Effect.gen(function* () {
      const sentMessages: Array<SentMessage> = [];
      const notifier = yield* makeTestNotifier({ sentMessages, readShell: () => null });
      const result = yield* notifier.notify("ping the phone");
      assert.deepEqual(result, { delivered: true });
      assert.lengthOf(sentMessages, 1);
      assert.equal(sentMessages[0]!.chatId, "42");
      assert.equal(sentMessages[0]!.text, "ping the phone");
    }),
  );

  it.effect("sends a test message with the saved token and chat", () =>
    Effect.gen(function* () {
      const sentMessages: Array<SentMessage> = [];
      const notifier = yield* makeTestNotifier({ sentMessages, readShell: () => null });
      yield* notifier.sendTest({});
      assert.lengthOf(sentMessages, 1);
      assert.equal(sentMessages[0]!.chatId, "42");
      assert.equal(sentMessages[0]!.text, "SimplyCode: Telegram notifications are set up.");
    }),
  );

  it.effect("refuses a test message without any token", () =>
    Effect.gen(function* () {
      const sentMessages: Array<SentMessage> = [];
      const notifier = yield* makeTestNotifier({
        sentMessages,
        telegramSettings: { botToken: "" },
        readShell: () => null,
      });
      const error = yield* notifier.sendTest({}).pipe(Effect.flip);
      assert.instanceOf(error, TelegramRequestError);
      assert.include(error.message, "bot token");
      assert.lengthOf(sentMessages, 0);
    }),
  );

  it.effect("lists chats for the detect button", () =>
    Effect.gen(function* () {
      const sentMessages: Array<SentMessage> = [];
      const notifier = yield* makeTestNotifier({
        sentMessages,
        chats: [{ id: "-100", title: "Team", type: "supergroup" }],
        readShell: () => null,
      });
      const result = yield* notifier.detectChats({});
      assert.deepEqual(result, {
        chats: [{ id: "-100", title: "Team", type: "supergroup" }],
      });
    }),
  );

  it.effect("confirms a completion is still the state before it sends", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const pulls = yield* Queue.unbounded<void>();
      const snapshotReads = yield* Queue.unbounded<void>();
      const sentQueue = yield* Queue.unbounded<SentMessage>();
      const sentMessages: Array<SentMessage> = [];
      const notifier = yield* makeTestNotifier({
        sentMessages,
        sentQueue,
        snapshotReads,
        readShell: () =>
          shell({ status: "completed", latestRunId: RUN_ID, latestRunCompletedAt: AFTER_START }),
        domainEvents: Stream.fromEffectRepeat(
          Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
        ),
      });
      yield* notifier.start();
      yield* Queue.take(pulls);
      yield* Queue.offer(events, runEvent("event-complete"));
      yield* Queue.take(snapshotReads);
      // The first look only schedules the confirmation; nothing is sent yet.
      assert.lengthOf(sentMessages, 0);
      yield* TestClock.adjust("5 seconds");
      const message = yield* Queue.take(sentQueue);
      assert.include(message.text, "Done:");
      assert.include(message.text, "Project");
      assert.include(message.text, "Model: test-model");
    }),
  );

  it.effect("stays silent when the run continues inside the confirmation window", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const pulls = yield* Queue.unbounded<void>();
      const snapshotReads = yield* Queue.unbounded<void>();
      const sentMessages: Array<SentMessage> = [];
      let current: OrchestrationV2ThreadShell | null = shell({
        status: "completed",
        latestRunId: RUN_ID,
        latestRunCompletedAt: AFTER_START,
      });
      const notifier = yield* makeTestNotifier({
        sentMessages,
        snapshotReads,
        readShell: () => current,
        domainEvents: Stream.fromEffectRepeat(
          Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(events))),
        ),
      });
      yield* notifier.start();
      yield* Queue.take(pulls);
      yield* Queue.offer(events, runEvent("event-continue"));
      yield* Queue.take(snapshotReads);
      // A continuation started before the five-second window ended.
      current = shell({ status: "running", latestRunCompletedAt: null });
      yield* TestClock.adjust("5 seconds");
      yield* Queue.take(snapshotReads);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.lengthOf(sentMessages, 0);
    }),
  );

  it.effect("notifies on a workflow run reaching a terminal status", () =>
    Effect.gen(function* () {
      const watch = yield* Queue.unbounded<WorkflowRunsSnapshot>();
      const sentQueue = yield* Queue.unbounded<SentMessage>();
      const sentMessages: Array<SentMessage> = [];
      const notifier = yield* makeTestNotifier({
        sentMessages,
        sentQueue,
        readShell: () => null,
        watch: Stream.fromEffectRepeat(Queue.take(watch)),
      });
      yield* notifier.start();
      // The first snapshot only sets the baseline, even for finished runs.
      yield* Queue.offer(watch, snapshot([workflowRun({ status: "completed" })]));
      yield* Queue.offer(
        watch,
        snapshot([
          workflowRun({ runId: "run-2", title: "Release", status: "running" }),
          workflowRun({ status: "completed" }),
        ]),
      );
      // The baseline run is silent; only run-2's later change speaks.
      yield* Queue.offer(
        watch,
        snapshot([workflowRun({ runId: "run-2", title: "Release", status: "stopped" })]),
      );
      const message = yield* Queue.take(sentQueue);
      assert.include(message.text, 'Pipeline "Release": failed');
    }),
  );
});
