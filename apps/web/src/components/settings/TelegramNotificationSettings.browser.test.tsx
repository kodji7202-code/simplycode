import { Atom } from "effect/reactivity";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { TelegramNotificationSettings } from "./TelegramNotificationSettings";

const environmentId = EnvironmentId.make("laptop");
const environment = { environmentId, label: "Laptop" };

const state = vi.hoisted(() => ({
  settings: {} as UnifiedSettings,
  calls: [] as Array<readonly [label: string, input: unknown]>,
  detectResult: { _tag: "Success", value: { chats: [] } } as unknown,
  testResult: { _tag: "Success", value: undefined } as unknown,
  updateSettings: vi.fn(),
}));

const savedTelegram = (patch: Record<string, unknown>) =>
  (state.settings = {
    ...state.settings,
    telegramNotifications: {
      ...DEFAULT_SERVER_SETTINGS.telegramNotifications,
      ...patch,
    },
  });

vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    environment,
    scope: { kind: "environment", environmentId },
  })) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: ((selector?: (settings: UnifiedSettings) => unknown) =>
    selector ? selector(state.settings) : state.settings) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.updateSettings,
  useScopedSettingsWriteAllowed: () => true,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const permissionAtom = () => Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      telegramTest: { label: "telegram-test", permissionAtom } as never,
      telegramDetectChats: { label: "telegram-detect-chats", permissionAtom } as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: { readonly label: string }) =>
    (value: { readonly input?: unknown }) => {
      state.calls.push([command.label, value.input]);
      return Promise.resolve(
        command.label === "telegram-detect-chats" ? state.detectResult : state.testResult,
      );
    }) as never,
}));

describe("TelegramNotificationSettings", () => {
  it("lists detected chats for the user to pick", async () => {
    savedTelegram({ botToken: "redacted" });
    state.calls = [];
    state.detectResult = {
      _tag: "Success",
      value: {
        chats: [
          { id: "42", title: "Home", type: "private" },
          { id: "-100", title: "Team", type: "group" },
        ],
      },
    };
    await using screen = await render(<TelegramNotificationSettings />, { router: false });
    state.updateSettings.mockReset().mockImplementation((patch) => {
      savedTelegram(patch.telegramNotifications ?? {});
      void screen.rerender(<TelegramNotificationSettings />);
    });

    await page.getByRole("button", { name: "Detect" }).click();

    await expect.element(page.getByText("Pick a chat")).toBeVisible();
    await page.getByRole("combobox", { name: "Detected chats" }).click();
    await page.getByRole("option", { name: "Home · 42" }).click();
    expect(state.updateSettings).toHaveBeenCalledWith({
      telegramNotifications: { chatId: "42" },
    });
    expect(state.calls).toEqual([["telegram-detect-chats", {}]]);
  });

  it("asks to message the bot when detect finds nothing", async () => {
    savedTelegram({ botToken: "redacted" });
    state.detectResult = { _tag: "Success", value: { chats: [] } };
    await using _screen = await render(<TelegramNotificationSettings />, { router: false });

    await page.getByRole("button", { name: "Detect" }).click();

    await expect
      .element(page.getByText("Send any message to your bot in Telegram, then press Detect again."))
      .toBeVisible();
  });

  it("reports a sent test message with the saved chat", async () => {
    savedTelegram({ botToken: "redacted", chatId: "42" });
    state.calls = [];
    state.testResult = { _tag: "Success", value: undefined };
    await using _screen = await render(<TelegramNotificationSettings />, { router: false });

    await page.getByRole("button", { name: "Send test message" }).click();

    await expect.element(page.getByText("Test message sent.")).toBeVisible();
    expect(state.calls).toEqual([["telegram-test", { chatId: "42" }]]);
  });
});
