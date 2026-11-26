import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HostPowerSnapshot } from "./background.ts";
import { DesktopUpdateChannelSchema, DesktopUpdateStateSchema } from "./ipc.ts";

export const RESOURCE_MONITOR_PROTOCOL_VERSION = 3 as const;

export const HostResourcesSnapshot = Schema.Struct({
  sampledAt: NonNegativeInt,
  cpuUtilization: Schema.NullOr(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  cpuCount: NonNegativeInt,
  availableMemoryBytes: NonNegativeInt,
  totalMemoryBytes: NonNegativeInt,
});
export type HostResourcesSnapshot = typeof HostResourcesSnapshot.Type;

export const ResourceUsageIoSemantics = Schema.Literals([
  "storage",
  "logical",
  "all-io",
  "unavailable",
]);
export type ResourceUsageIoSemantics = typeof ResourceUsageIoSemantics.Type;

export const ResourceUsageProcessCategory = Schema.Literals([
  "server",
  "server-child",
  "provider-root",
  "terminal-root",
  "electron-main",
  "electron-renderer",
  "electron-gpu",
  "electron-utility",
  "resource-monitor",
  "unknown-t3",
]);
export type ResourceUsageProcessCategory = typeof ResourceUsageProcessCategory.Type;

export const ResourceUsageSourceStatus = Schema.Literals([
  "starting",
  "healthy",
  "degraded",
  "unavailable",
  "stopped",
]);
export type ResourceUsageSourceStatus = typeof ResourceUsageSourceStatus.Type;

export const ResourceUsageProcessIdentity = Schema.Struct({
  pid: PositiveInt,
  startTimeMs: NonNegativeInt,
});
export type ResourceUsageProcessIdentity = typeof ResourceUsageProcessIdentity.Type;

export const ResourceMonitorExternalProcess = Schema.Struct({
  pid: PositiveInt,
  startTimeMs: Schema.optionalKey(NonNegativeInt),
});
export type ResourceMonitorExternalProcess = typeof ResourceMonitorExternalProcess.Type;

export const ResourceMonitorCapabilities = Schema.Struct({
  cumulativeCpuTime: Schema.Boolean,
  currentCpuPercent: Schema.Boolean,
  residentMemory: Schema.Boolean,
  virtualMemory: Schema.Boolean,
  ioBytes: Schema.Boolean,
  processStartTime: Schema.Boolean,
  processTree: Schema.Boolean,
});
export type ResourceMonitorCapabilities = typeof ResourceMonitorCapabilities.Type;

export const ResourceMonitorProcessSample = Schema.Struct({
  pid: PositiveInt,
  ppid: NonNegativeInt,
  startTimeMs: NonNegativeInt,
  runTimeMs: NonNegativeInt,
  name: Schema.String,
  command: Schema.String,
  status: Schema.String,
  cpuPercent: Schema.Number,
  cpuTimeMs: NonNegativeInt,
  residentBytes: NonNegativeInt,
  virtualBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  ioSemantics: Schema.Literals(["storage", "all-io"]),
});
export type ResourceMonitorProcessSample = typeof ResourceMonitorProcessSample.Type;

export const ResourceMonitorConfigureCommand = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("configure"),
  rootPid: PositiveInt,
  sampleIntervalMs: NonNegativeInt,
  externalProcesses: Schema.Array(ResourceMonitorExternalProcess),
});
export type ResourceMonitorConfigureCommand = typeof ResourceMonitorConfigureCommand.Type;

export const ResourceMonitorSetExternalProcessesCommand = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("setExternalProcesses"),
  processes: Schema.Array(ResourceMonitorExternalProcess),
});
export type ResourceMonitorSetExternalProcessesCommand =
  typeof ResourceMonitorSetExternalProcessesCommand.Type;

export const ResourceMonitorSampleNowCommand = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("sampleNow"),
  requestId: TrimmedNonEmptyString,
});
export type ResourceMonitorSampleNowCommand = typeof ResourceMonitorSampleNowCommand.Type;

export const ResourceMonitorProcessTableCommand = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("processTable"),
  requestId: TrimmedNonEmptyString,
});
export type ResourceMonitorProcessTableCommand = typeof ResourceMonitorProcessTableCommand.Type;

export const ResourceMonitorSetSampleIntervalCommand = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("setSampleInterval"),
  sampleIntervalMs: NonNegativeInt,
});
export type ResourceMonitorSetSampleIntervalCommand =
  typeof ResourceMonitorSetSampleIntervalCommand.Type;

export const ResourceMonitorSetStreamingCommand = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("setStreaming"),
  enabled: Schema.Boolean,
});
export type ResourceMonitorSetStreamingCommand = typeof ResourceMonitorSetStreamingCommand.Type;

export const ResourceMonitorReadHistoryCommand = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("readHistory"),
  requestId: TrimmedNonEmptyString,
  windowMs: NonNegativeInt,
});
export type ResourceMonitorReadHistoryCommand = typeof ResourceMonitorReadHistoryCommand.Type;

export const ResourceMonitorShutdownCommand = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("shutdown"),
});
export type ResourceMonitorShutdownCommand = typeof ResourceMonitorShutdownCommand.Type;

export const ResourceMonitorCommand = Schema.Union([
  ResourceMonitorConfigureCommand,
  ResourceMonitorSetExternalProcessesCommand,
  ResourceMonitorSetSampleIntervalCommand,
  ResourceMonitorSetStreamingCommand,
  ResourceMonitorSampleNowCommand,
  ResourceMonitorProcessTableCommand,
  ResourceMonitorReadHistoryCommand,
  ResourceMonitorShutdownCommand,
]);
export type ResourceMonitorCommand = typeof ResourceMonitorCommand.Type;

export const ResourceMonitorHelloEvent = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("hello"),
  sidecarVersion: TrimmedNonEmptyString,
  sidecarPid: PositiveInt,
  platform: TrimmedNonEmptyString,
  arch: TrimmedNonEmptyString,
  capabilities: ResourceMonitorCapabilities,
});
export type ResourceMonitorHelloEvent = typeof ResourceMonitorHelloEvent.Type;

export const ResourceMonitorSnapshotEvent = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("snapshot"),
  sequence: NonNegativeInt,
  sampledAtUnixMs: NonNegativeInt,
  collectionDurationMicros: NonNegativeInt,
  scannedProcessCount: NonNegativeInt,
  retainedProcessCount: NonNegativeInt,
  inaccessibleProcessCount: NonNegativeInt,
  requestId: Schema.optionalKey(TrimmedNonEmptyString),
  externalProcesses: Schema.optionalKey(Schema.Array(ResourceMonitorExternalProcess)),
  processes: Schema.Array(ResourceMonitorProcessSample),
});
export type ResourceMonitorSnapshotEvent = typeof ResourceMonitorSnapshotEvent.Type;

export const ResourceMonitorProcessTableEntry = Schema.Struct({
  pid: PositiveInt,
  ppid: NonNegativeInt,
  name: Schema.String,
});
export type ResourceMonitorProcessTableEntry = typeof ResourceMonitorProcessTableEntry.Type;

export const ResourceMonitorProcessTableEvent = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("processTable"),
  requestId: TrimmedNonEmptyString,
  processes: Schema.Array(ResourceMonitorProcessTableEntry),
});
export type ResourceMonitorProcessTableEvent = typeof ResourceMonitorProcessTableEvent.Type;

export const ResourceMonitorHistoryChunkEvent = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("historyChunk"),
  requestId: TrimmedNonEmptyString,
  done: Schema.Boolean,
  snapshots: Schema.Array(ResourceMonitorSnapshotEvent),
});
export type ResourceMonitorHistoryChunkEvent = typeof ResourceMonitorHistoryChunkEvent.Type;

export const ResourceMonitorErrorEvent = Schema.Struct({
  version: Schema.Literal(RESOURCE_MONITOR_PROTOCOL_VERSION),
  type: Schema.Literal("error"),
  code: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  recoverable: Schema.Boolean,
});
export type ResourceMonitorErrorEvent = typeof ResourceMonitorErrorEvent.Type;

export const ResourceMonitorEvent = Schema.Union([
  ResourceMonitorHelloEvent,
  ResourceMonitorSnapshotEvent,
  ResourceMonitorProcessTableEvent,
  ResourceMonitorHistoryChunkEvent,
  ResourceMonitorErrorEvent,
]);
export type ResourceMonitorEvent = typeof ResourceMonitorEvent.Type;

export const DesktopElectronProcessType = Schema.Literals([
  "Browser",
  "Tab",
  "Utility",
  "Zygote",
  "Sandbox helper",
  "GPU",
  "Pepper Plugin",
  "Pepper Plugin Broker",
  "Unknown",
]);
export type DesktopElectronProcessType = typeof DesktopElectronProcessType.Type;

export const DesktopElectronProcessMetric = Schema.Struct({
  pid: PositiveInt,
  creationTimeMs: NonNegativeInt,
  type: DesktopElectronProcessType,
  name: Schema.optionalKey(Schema.String),
  serviceName: Schema.optionalKey(Schema.String),
  cpuPercent: Schema.Number,
  cumulativeCpuSeconds: Schema.optionalKey(Schema.Number),
  idleWakeupsPerSecond: Schema.Number,
  workingSetBytes: NonNegativeInt,
  peakWorkingSetBytes: NonNegativeInt,
});
export type DesktopElectronProcessMetric = typeof DesktopElectronProcessMetric.Type;

const DesktopHostPowerSnapshot = Schema.Struct({
  ...HostPowerSnapshot.fields,
  updatedAt: Schema.DateTimeUtcFromString,
});

export const DesktopHostResourceSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("desktopResource"),
  sequence: NonNegativeInt,
  sampledAtUnixMs: NonNegativeInt,
  electronPid: PositiveInt,
  power: DesktopHostPowerSnapshot,
  speedLimitPercent: Schema.OptionFromNullOr(Schema.Number),
  electronProcesses: Schema.Array(DesktopElectronProcessMetric),
});
export type DesktopHostResourceSnapshot = typeof DesktopHostResourceSnapshot.Type;

export const DesktopHostResourceHello = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("desktopResourceHello"),
  electronPid: PositiveInt,
});
export type DesktopHostResourceHello = typeof DesktopHostResourceHello.Type;

export const DesktopUpdateRemoteOutcome = Schema.Literals([
  "ready-to-install",
  "up-to-date",
  "failed",
]);
export type DesktopUpdateRemoteOutcome = typeof DesktopUpdateRemoteOutcome.Type;

export const DesktopUpdateStatusReport = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("desktopUpdateStatus"),
  requestId: Schema.optionalKey(TrimmedNonEmptyString),
  preparedRequestId: Schema.optionalKey(TrimmedNonEmptyString),
  outcome: Schema.optionalKey(DesktopUpdateRemoteOutcome),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
  state: DesktopUpdateStateSchema,
});
export type DesktopUpdateStatusReport = typeof DesktopUpdateStatusReport.Type;

export const ShellEnvironmentPatch = Schema.Struct({
  PATH: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ANDROID_HOME: Schema.optionalKey(Schema.NullOr(Schema.String)),
  ANDROID_SDK_ROOT: Schema.optionalKey(Schema.NullOr(Schema.String)),
  DBUS_SESSION_BUS_ADDRESS: Schema.optionalKey(Schema.NullOr(Schema.String)),
  DISPLAY: Schema.optionalKey(Schema.NullOr(Schema.String)),
  LANG: Schema.optionalKey(Schema.NullOr(Schema.String)),
  LC_ALL: Schema.optionalKey(Schema.NullOr(Schema.String)),
  LC_CTYPE: Schema.optionalKey(Schema.NullOr(Schema.String)),
  SSH_AUTH_SOCK: Schema.optionalKey(Schema.NullOr(Schema.String)),
  HOMEBREW_PREFIX: Schema.optionalKey(Schema.NullOr(Schema.String)),
  HOMEBREW_CELLAR: Schema.optionalKey(Schema.NullOr(Schema.String)),
  HOMEBREW_REPOSITORY: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_CONFIG_HOME: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_CURRENT_DESKTOP: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_DATA_HOME: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_RUNTIME_DIR: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_SESSION_DESKTOP: Schema.optionalKey(Schema.NullOr(Schema.String)),
  XDG_SESSION_TYPE: Schema.optionalKey(Schema.NullOr(Schema.String)),
  WAYLAND_DISPLAY: Schema.optionalKey(Schema.NullOr(Schema.String)),
  SSL_CERT_FILE: Schema.optionalKey(Schema.NullOr(Schema.String)),
  SSL_CERT_DIR: Schema.optionalKey(Schema.NullOr(Schema.String)),
  NODE_EXTRA_CA_CERTS: Schema.optionalKey(Schema.NullOr(Schema.String)),
  T3CODE_FEATURE_FLAGS: Schema.optionalKey(Schema.NullOr(Schema.String)),
  T3CODE_RELEASE_BASE_URL: Schema.optionalKey(Schema.NullOr(Schema.String)),
  __MISE_DIFF: Schema.optionalKey(Schema.NullOr(Schema.String)),
  JAVA_HOME: Schema.optionalKey(Schema.NullOr(Schema.String)),
  PNPM_HOME: Schema.optionalKey(Schema.NullOr(Schema.String)),
  FNM_DIR: Schema.optionalKey(Schema.NullOr(Schema.String)),
  FNM_MULTISHELL_PATH: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type ShellEnvironmentPatch = typeof ShellEnvironmentPatch.Type;

export const DesktopShellEnvironmentSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("shellEnvironment"),
  discovered: Schema.Boolean,
  platform: Schema.String,
  environment: ShellEnvironmentPatch,
});
export type DesktopShellEnvironmentSnapshot = typeof DesktopShellEnvironmentSnapshot.Type;

export const DesktopHostResourceMessage = Schema.Union([
  DesktopHostResourceHello,
  DesktopShellEnvironmentSnapshot,
  DesktopHostResourceSnapshot,
  DesktopUpdateStatusReport,
]);
export type DesktopHostResourceMessage = typeof DesktopHostResourceMessage.Type;

export const DesktopResourceSetDiagnosticsDemand = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("setDiagnosticsDemand"),
  enabled: Schema.Boolean,
});
export type DesktopResourceSetDiagnosticsDemand = typeof DesktopResourceSetDiagnosticsDemand.Type;

export const DesktopResourceSetHostPowerIntervals = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("setHostPowerIntervals"),
  activeIntervalMs: PositiveInt,
  idleIntervalMs: PositiveInt,
});
export type DesktopResourceSetHostPowerIntervals = typeof DesktopResourceSetHostPowerIntervals.Type;

/** Runs check/download/quit-and-install without local confirmation; the remote RPC click supplies consent. */
export const DesktopResourceRequestDesktopUpdate = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("requestDesktopUpdate"),
  requestId: TrimmedNonEmptyString,
  /** A track switch: move to this channel first, and install only `targetVersion`. */
  channel: Schema.optionalKey(DesktopUpdateChannelSchema),
  targetVersion: Schema.optionalKey(TrimmedNonEmptyString),
});
export type DesktopResourceRequestDesktopUpdate = typeof DesktopResourceRequestDesktopUpdate.Type;

export const DesktopResourceCommitDesktopUpdate = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("commitDesktopUpdate"),
  requestId: TrimmedNonEmptyString,
});
export type DesktopResourceCommitDesktopUpdate = typeof DesktopResourceCommitDesktopUpdate.Type;

export const DesktopResourceCancelDesktopUpdate = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("cancelDesktopUpdate"),
  requestId: TrimmedNonEmptyString,
});
export type DesktopResourceCancelDesktopUpdate = typeof DesktopResourceCancelDesktopUpdate.Type;

/** The server accepts requests; the desktop treats this as backend readiness. */
export const DesktopResourceServerReady = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("serverReady"),
});
export type DesktopResourceServerReady = typeof DesktopResourceServerReady.Type;

export const DesktopResourceControlMessage = Schema.Union([
  DesktopResourceServerReady,
  DesktopResourceSetDiagnosticsDemand,
  DesktopResourceSetHostPowerIntervals,
  DesktopResourceRequestDesktopUpdate,
  DesktopResourceCommitDesktopUpdate,
  DesktopResourceCancelDesktopUpdate,
]);
export type DesktopResourceControlMessage = typeof DesktopResourceControlMessage.Type;

export const ResourceUsageProcess = Schema.Struct({
  identity: ResourceUsageProcessIdentity,
  ppid: NonNegativeInt,
  childPids: Schema.Array(PositiveInt),
  depth: NonNegativeInt,
  name: Schema.String,
  command: Schema.String,
  status: Schema.String,
  category: ResourceUsageProcessCategory,
  electronType: Schema.optionalKey(DesktopElectronProcessType),
  electronServiceName: Schema.optionalKey(Schema.String),
  cpuPercent: Schema.Number,
  cpuTimeMs: NonNegativeInt,
  residentBytes: NonNegativeInt,
  peakResidentBytes: NonNegativeInt,
  virtualBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  ioReadBytesPerSecond: Schema.Number,
  ioWriteBytesPerSecond: Schema.Number,
  ioSemantics: ResourceUsageIoSemantics,
  idleWakeupsPerSecond: Schema.optionalKey(Schema.Number),
  runTimeMs: NonNegativeInt,
  firstSeenAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.DateTimeUtc,
});
export type ResourceUsageProcess = typeof ResourceUsageProcess.Type;

export const ResourceUsageAggregate = Schema.Struct({
  processCount: NonNegativeInt,
  currentCpuPercent: Schema.Number,
  cpuTimeMs: NonNegativeInt,
  currentRssBytes: NonNegativeInt,
  peakRssBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  ioReadBytesPerSecond: Schema.Number,
  ioWriteBytesPerSecond: Schema.Number,
  processStarts: NonNegativeInt,
  processExits: NonNegativeInt,
});
export type ResourceUsageAggregate = typeof ResourceUsageAggregate.Type;

export const ResourceUsageGroups = Schema.Struct({
  backend: ResourceUsageAggregate,
  electron: ResourceUsageAggregate,
  monitor: ResourceUsageAggregate,
  allT3: ResourceUsageAggregate,
});
export type ResourceUsageGroups = typeof ResourceUsageGroups.Type;

export const ResourceUsageSourceHealth = Schema.Struct({
  status: ResourceUsageSourceStatus,
  lastSampleAt: Schema.Option(Schema.DateTimeUtc),
  lastError: Schema.Option(TrimmedNonEmptyString),
});
export type ResourceUsageSourceHealth = typeof ResourceUsageSourceHealth.Type;

export const ResourceUsageHealth = Schema.Struct({
  native: ResourceUsageSourceHealth,
  desktop: ResourceUsageSourceHealth,
  sidecarVersion: Schema.Option(TrimmedNonEmptyString),
  sidecarPid: Schema.Option(PositiveInt),
  restartCount: NonNegativeInt,
  collectionDurationMicros: NonNegativeInt,
  scannedProcessCount: NonNegativeInt,
  retainedProcessCount: NonNegativeInt,
  inaccessibleProcessCount: NonNegativeInt,
});
export type ResourceUsageHealth = typeof ResourceUsageHealth.Type;

export const ResourceAttributionEntry = Schema.Struct({
  component: TrimmedNonEmptyString,
  operation: TrimmedNonEmptyString,
  logicalReadBytes: NonNegativeInt,
  logicalWriteBytes: NonNegativeInt,
  count: NonNegativeInt,
  durationMs: NonNegativeInt,
});
export type ResourceAttributionEntry = typeof ResourceAttributionEntry.Type;

export const ResourceAttributionSnapshot = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  entries: Schema.Array(ResourceAttributionEntry),
});
export type ResourceAttributionSnapshot = typeof ResourceAttributionSnapshot.Type;

export const ResourceUsageSnapshot = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  sampleIntervalMs: NonNegativeInt,
  processes: Schema.Array(ResourceUsageProcess),
  groups: ResourceUsageGroups,
  power: HostPowerSnapshot,
  speedLimitPercent: Schema.Option(Schema.Number),
  attribution: ResourceAttributionSnapshot,
  health: ResourceUsageHealth,
});
export type ResourceUsageSnapshot = typeof ResourceUsageSnapshot.Type;

export const ResourceUsageHistoryInput = Schema.Struct({
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
});
export type ResourceUsageHistoryInput = typeof ResourceUsageHistoryInput.Type;

export const ResourceUsageHistoryBucket = Schema.Struct({
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.DateTimeUtc,
  avgCpuPercent: Schema.Number,
  maxCpuPercent: Schema.Number,
  maxRssBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  maxProcessCount: NonNegativeInt,
});
export type ResourceUsageHistoryBucket = typeof ResourceUsageHistoryBucket.Type;

export const ResourceUsageProcessSummary = Schema.Struct({
  identity: ResourceUsageProcessIdentity,
  ppid: NonNegativeInt,
  depth: NonNegativeInt,
  name: Schema.String,
  command: Schema.String,
  category: ResourceUsageProcessCategory,
  firstSeenAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.DateTimeUtc,
  currentCpuPercent: Schema.Number,
  avgCpuPercent: Schema.Number,
  maxCpuPercent: Schema.Number,
  cpuTimeMs: NonNegativeInt,
  currentRssBytes: NonNegativeInt,
  peakRssBytes: NonNegativeInt,
  ioReadBytes: NonNegativeInt,
  ioWriteBytes: NonNegativeInt,
  ioSemantics: ResourceUsageIoSemantics,
  sampleCount: NonNegativeInt,
});
export type ResourceUsageProcessSummary = typeof ResourceUsageProcessSummary.Type;

export const ResourceUsageHistory = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
  sampleIntervalMs: NonNegativeInt,
  retainedSampleCount: NonNegativeInt,
  buckets: Schema.Array(ResourceUsageHistoryBucket),
  topProcesses: Schema.Array(ResourceUsageProcessSummary),
  health: ResourceUsageHealth,
});
export type ResourceUsageHistory = typeof ResourceUsageHistory.Type;

export const ResourceUsageRetryResult = Schema.Struct({
  accepted: Schema.Boolean,
  snapshot: ResourceUsageSnapshot,
});
export type ResourceUsageRetryResult = typeof ResourceUsageRetryResult.Type;
