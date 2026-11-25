import { expect, it } from "@effect/vitest";
import {
  Bot,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import * as Policy from "./botManagerPolicy.ts";

const decodeBot = Schema.decodeUnknownSync(Bot);

const bot = (overrides?: Record<string, unknown>): Bot =>
  decodeBot({
    id: "manager",
    name: "Manager",
    enabled: true,
    projectId: "project-1",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "devin", model: "swe-2-high" },
    approvalMode: "auto-safe",
    canManageBots: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    soulBytes: 4,
    threadTag: "bot:manager",
    ...overrides,
  });

const devinProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("devin"),
  driver: ProviderDriverKind.make("devin"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-13T00:00:00.000Z",
  models: [
    { slug: "swe-2-high", name: "SWE-2 High", isCustom: false, capabilities: null },
    { slug: "swe-1.6", name: "SWE-1.6", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};

const caller = bot();

it("ranks approval modes ask < auto-safe < full", () => {
  expect(Policy.approvalRank("ask")).toBe(0);
  expect(Policy.approvalRank("auto-safe")).toBe(1);
  expect(Policy.approvalRank("full")).toBe(2);
});

it("managerDenial rejects a missing, disabled, or non-manager bot with the same message", () => {
  expect(Policy.managerDenial(undefined)).toBe(Policy.NOT_A_MANAGER_MESSAGE);
  expect(Policy.managerDenial(bot({ enabled: false }))).toBe(Policy.NOT_A_MANAGER_MESSAGE);
  expect(Policy.managerDenial(bot({ canManageBots: false }))).toBe(Policy.NOT_A_MANAGER_MESSAGE);
  expect(Policy.managerDenial(caller)).toBeUndefined();
});

it("approvalDenial names both modes only when the request is higher", () => {
  expect(Policy.approvalDenial("full", "auto-safe")).toBe(
    'Approval mode "full" is above your own ("auto-safe").',
  );
  expect(Policy.approvalDenial("auto-safe", "full")).toBeUndefined();
  expect(Policy.approvalDenial("ask", "auto-safe")).toBeUndefined();
  expect(Policy.approvalDenial("full", "full")).toBeUndefined();
});

it("createDenial defaults the new approval mode to the caller's", () => {
  expect(Policy.createDenial(caller, {})).toBeUndefined();
  expect(Policy.createDenial(caller, { approvalMode: "ask" })).toBeUndefined();
  expect(Policy.createDenial(caller, { approvalMode: "full" })).toBe(
    'Approval mode "full" is above your own ("auto-safe").',
  );
  // A caller at ask may only create ask-mode bots.
  const askCaller = bot({ approvalMode: "ask" });
  expect(Policy.createDenial(askCaller, {})).toBeUndefined();
  expect(Policy.createDenial(askCaller, { approvalMode: "auto-safe" })).toBe(
    'Approval mode "auto-safe" is above your own ("ask").',
  );
});

it("updateDenial refuses self, managers, and approval raises", () => {
  const target = bot({ id: "worker", canManageBots: false });
  expect(Policy.updateDenial(caller, target, {})).toBeUndefined();
  expect(Policy.updateDenial(caller, caller, {})).toBe("You can't edit yourself.");
  expect(Policy.updateDenial(caller, bot({ id: "other-manager" }), {})).toBe(
    "You can't edit another bot that manages bots.",
  );
  expect(Policy.updateDenial(caller, target, { approvalMode: "full" })).toBe(
    'Approval mode "full" is above your own ("auto-safe").',
  );
  expect(Policy.updateDenial(caller, target, { approvalMode: "ask" })).toBeUndefined();
});

it("installSkillDenial allows self and non-manager targets only", () => {
  expect(Policy.installSkillDenial(caller, caller)).toBeUndefined();
  expect(
    Policy.installSkillDenial(caller, bot({ id: "worker", canManageBots: false })),
  ).toBeUndefined();
  expect(Policy.installSkillDenial(caller, bot({ id: "other-manager" }))).toBe(
    "You can't edit another bot that manages bots.",
  );
});

it("resolveModelPick maps an existing slug and refuses anything else", () => {
  expect(
    Policy.resolveModelPick({ providerInstanceId: "devin", model: "swe-2-high" }, [devinProvider]),
  ).toEqual({ modelSelection: { instanceId: "devin", model: "swe-2-high" } });
  // The instance id match is case-insensitive, like the import mapping.
  expect(
    Policy.resolveModelPick({ providerInstanceId: "DEVIN", model: "swe-1.6" }, [devinProvider]),
  ).toEqual({ modelSelection: { instanceId: "devin", model: "swe-1.6" } });
  expect(
    Policy.resolveModelPick({ providerInstanceId: "devin", model: "ghost" }, [devinProvider]),
  ).toEqual({
    denial:
      'Model "ghost" is not available on provider "devin". Available provider instances: devin.',
  });
  expect(
    Policy.resolveModelPick({ providerInstanceId: "acme", model: "swe-2-high" }, [devinProvider]),
  ).toEqual({
    denial:
      'Model "swe-2-high" is not available on provider "acme". Available provider instances: devin.',
  });
  expect(Policy.resolveModelPick({ providerInstanceId: "acme", model: "x" }, [])).toEqual({
    denial: 'Model "x" is not available on provider "acme". Available provider instances: none.',
  });
});
