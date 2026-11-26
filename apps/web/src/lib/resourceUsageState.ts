import { AuthDiagnosticsReadScope } from "@t3tools/contracts";
import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import type {
  EnvironmentId,
  ResourceUsageHistoryInput,
  ResourceUsageSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { msg, useMessages } from "gt-react";

import { m } from "../i18n/messages";
import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";

export interface ResourceUsageState {
  readonly data: ResourceUsageSnapshot | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
  readonly retry: () => Promise<ResourceUsageSnapshot>;
}

export function useResourceUsage(targetEnvironmentId?: EnvironmentId | null): ResourceUsageState {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId =
    targetEnvironmentId === undefined
      ? (primaryEnvironment?.environmentId ?? null)
      : targetEnvironmentId;
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const resolve = useMessages();
  const query = useEnvironmentQuery(
    environmentId === null || !canReadDiagnostics
      ? null
      : serverEnvironment.resourceUsage({ environmentId, input: {} }),
    resolve,
  );
  const retryCommand = useAtomCommand(serverEnvironment.retryResourceUsage, {
    reportFailure: false,
  });
  const retry = async () => {
    if (environmentId === null) {
      throw new Error(m(msg("No environment is selected.")));
    }
    if (
      !readEnvironmentScope(environmentId, AuthEnvironmentMaintainScope) ||
      !readEnvironmentScope(environmentId, AuthDiagnosticsReadScope)
    ) {
      throw new Error(m(msg("This connection cannot restart the resource monitor.")));
    }
    const result = await retryCommand({ environmentId, input: {} });
    if (result._tag === "Failure") {
      throw Cause.squash(result.cause);
    }
    query.refresh();
    return result.value.snapshot;
  };

  // The live subscription keeps waiting for updates after its first snapshot.
  const isPending = query.isPending && query.data === null && query.error === null;
  return { ...query, isPending, retry };
}

export function useResourceUsageHistory(
  input: ResourceUsageHistoryInput,
  targetEnvironmentId?: EnvironmentId | null,
) {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId =
    targetEnvironmentId === undefined
      ? (primaryEnvironment?.environmentId ?? null)
      : targetEnvironmentId;
  const canReadDiagnostics = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const resolve = useMessages();
  return useEnvironmentQuery(
    environmentId === null || !canReadDiagnostics
      ? null
      : serverEnvironment.resourceUsageHistory({ environmentId, input }),
    resolve,
  );
}
