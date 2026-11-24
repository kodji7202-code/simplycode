import { EnvironmentId } from "@t3tools/contracts";

import {
  useConnectedEnvironmentIds,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";

/** Resolves the bots-section environment: the `env` search param, else primary/first connected. */
export function useBotsEnvironment(askedEnv: string | undefined) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const connectedIds = useConnectedEnvironmentIds();
  const { environments } = useEnvironments();
  const connected = environments.filter((environment) =>
    connectedIds.includes(environment.environmentId),
  );
  const asked = askedEnv === undefined ? null : EnvironmentId.make(askedEnv);
  const environmentId =
    asked !== null
      ? (connected.find((environment) => environment.environmentId === asked)?.environmentId ??
        null)
      : (connected.find((environment) => environment.environmentId === primaryEnvironmentId)
          ?.environmentId ??
        connected[0]?.environmentId ??
        null);
  return { connected, environmentId };
}
