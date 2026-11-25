// @effect-diagnostics nodeBuiltinImport:off
import type { RuntimeMode } from "@t3tools/contracts";
import {
  canonicalPathForContainment,
  pathIsWithinRoot,
  resolveContainedPath,
} from "@t3tools/shared/pathContainment";
import type * as EffectAcpSchema from "effect-acp/compat";

export interface AcpRuntimePolicy {
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string | null;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
  readonly workspace?: { readonly extraRoots: ReadonlyArray<string> } | undefined;
}

export type AcpPermissionDisposition = "allow" | "ask" | "deny";

export function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

interface AcpPolicyOperation {
  readonly kind: string | null | undefined;
  readonly locations: ReadonlyArray<{ readonly path: string }> | null | undefined;
}

function acpPolicyRequiresApproval(runtimePolicy: AcpRuntimePolicy): boolean {
  return runtimePolicy.approvalPolicy === undefined
    ? runtimePolicy.runtimeMode === "approval-required"
    : runtimePolicy.approvalPolicy !== "never";
}

function isAcpReadKind(toolKind: string): boolean {
  return toolKind === "read" || toolKind === "search" || toolKind === "think";
}

/** Reads never ask; an absent sandbox implies read-only in approval-required mode. */
function acpReadDisposition(runtimePolicy: AcpRuntimePolicy): "allow" | "deny" {
  switch (unknownRecord(runtimePolicy.sandboxPolicy)?.type) {
    case undefined:
    case "readOnly":
    case "workspaceWrite":
    case "dangerFullAccess":
    case "externalSandbox":
      return "allow";
    default:
      return "deny";
  }
}

function acpWorkspaceWriteAllowsMutation(
  runtimePolicy: AcpRuntimePolicy,
  sandboxPolicy: Record<string, unknown>,
  locations: AcpPolicyOperation["locations"],
): boolean {
  const cwd =
    typeof runtimePolicy.cwd === "string" && runtimePolicy.cwd.trim().length > 0
      ? (resolveContainedPath(runtimePolicy.cwd, process.cwd()) ?? null)
      : null;
  const roots: Array<string> = [];
  if (cwd !== null) {
    const canonicalCwd = canonicalPathForContainment(cwd);
    if (canonicalCwd !== undefined) roots.push(canonicalCwd);
  }
  const writableRoots = [
    ...(Array.isArray(sandboxPolicy.writableRoots) ? sandboxPolicy.writableRoots : []),
    ...(runtimePolicy.workspace?.extraRoots ?? []),
  ];
  for (const writableRoot of writableRoots) {
    if (typeof writableRoot !== "string") continue;
    const resolved = resolveContainedPath(writableRoot, cwd);
    if (resolved === undefined) continue;
    const canonicalRoot = canonicalPathForContainment(resolved);
    if (canonicalRoot !== undefined) roots.push(canonicalRoot);
  }
  if (roots.length === 0) return false;

  if (locations === undefined || locations === null || locations.length === 0) {
    return false;
  }
  for (const location of locations) {
    const resolved = resolveContainedPath(location.path, cwd);
    const canonicalPath =
      resolved === undefined ? undefined : canonicalPathForContainment(resolved);
    if (
      canonicalPath === undefined ||
      !roots.some((root) => pathIsWithinRoot(canonicalPath, root))
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The denial a `workspaceWrite` confinement refuse carries, attached to the permission response's
 * `_meta` for an agent that surfaces it.
 */
export function acpWorkspaceWriteDenyReason(runtimePolicy: AcpRuntimePolicy): string | undefined {
  if (unknownRecord(runtimePolicy.sandboxPolicy)?.type !== "workspaceWrite") return undefined;
  const cwd =
    typeof runtimePolicy.cwd === "string" && runtimePolicy.cwd.trim().length > 0
      ? runtimePolicy.cwd
      : "the project";
  return `SimplyCode: this bot stays in its project. Writing outside ${cwd} is not allowed.`;
}

function acpOperationDisposition(
  runtimePolicy: AcpRuntimePolicy,
  operation: AcpPolicyOperation,
): AcpPermissionDisposition {
  const toolKind = operation.kind ?? "other";
  if (isAcpReadKind(toolKind)) {
    return acpReadDisposition(runtimePolicy);
  }

  const sandboxPolicy = unknownRecord(runtimePolicy.sandboxPolicy);
  if (sandboxPolicy?.type === "workspaceWrite") {
    // Confinement rides on top of the mode's own answers: a mutation inside the
    // workspace or an execute gets what the mode would give anyway, and only a
    // mutation escaping the writable roots is refused outright. One that names
    // no location cannot be checked and fails closed the same way.
    const normal = acpOperationDisposition(
      { ...runtimePolicy, sandboxPolicy: undefined },
      operation,
    );
    if (isAcpMutationKind(toolKind)) {
      return acpWorkspaceWriteAllowsMutation(runtimePolicy, sandboxPolicy, operation.locations)
        ? normal
        : "deny";
    }
    return normal;
  }

  if (acpPolicyRequiresApproval(runtimePolicy)) {
    return "ask";
  }

  switch (sandboxPolicy?.type) {
    case "readOnly":
      return "deny";
    case "workspaceWrite":
      return "deny";
    case "dangerFullAccess":
    case "externalSandbox":
      return "allow";
    case undefined:
      if (runtimePolicy.runtimeMode === "approval-required") return "deny";
      if (
        runtimePolicy.runtimeMode === "auto-accept-edits" &&
        runtimePolicy.approvalPolicy === undefined &&
        !isAcpMutationKind(toolKind)
      ) {
        return "ask";
      }
      return "allow";
    default:
      return "deny";
  }
}

function isAcpMutationKind(toolKind: string): boolean {
  return toolKind === "edit" || toolKind === "delete" || toolKind === "move";
}

export function acpPermissionDisposition(
  runtimePolicy: AcpRuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  return acpOperationDisposition(runtimePolicy, {
    kind: request.toolCall.kind,
    locations: request.toolCall.locations,
  });
}

export function acpMcpToolApprovalElicitationDisposition(
  runtimePolicy: AcpRuntimePolicy,
  request: EffectAcpSchema.CreateElicitationRequest,
  nativeRequestId?: string,
): "ask" | "allow" | undefined {
  if (
    request.mode !== "form" ||
    (unknownRecord(request._meta)?.codex_approval_kind !== "mcp_tool_call" &&
      nativeRequestId?.startsWith("mcp_tool_call_approval_") !== true)
  ) {
    return undefined;
  }
  // T3's authenticated MCP endpoint enforces scope; only explicit approval mode needs a user prompt.
  return acpPolicyRequiresApproval(runtimePolicy) ? "ask" : "allow";
}

export function acpClientExecuteDisposition(
  runtimePolicy: AcpRuntimePolicy,
): AcpPermissionDisposition {
  return acpOperationDisposition(runtimePolicy, { kind: "execute", locations: undefined });
}

export interface AcpApprovalGrantInput {
  /** The approved request's ACP tool kind, after ID-only requests take their tracked call's kind. */
  readonly toolKind: string;
  readonly scope: "session" | "turn";
  readonly turnKey: string;
}

export interface AcpClientPolicyGrants {
  readonly recordApproval: (input: AcpApprovalGrantInput) => void;
  readonly allowsExecute: (turnKey: string | null) => boolean;
}

/** ACP cannot link commands to terminals; approved execute requests grant execution for the turn or accepted session. */
export function makeAcpClientPolicyGrants(): AcpClientPolicyGrants {
  let sessionExecute = false;
  let turnExecute: string | null = null;
  return {
    recordApproval: (input) => {
      // Other kinds also show as command cards, but approving them must not open terminals.
      if (input.toolKind !== "execute") return;
      if (input.scope === "session") {
        sessionExecute = true;
      } else {
        turnExecute = input.turnKey;
      }
    },
    allowsExecute: (turnKey) => sessionExecute || (turnKey !== null && turnExecute === turnKey),
  };
}
