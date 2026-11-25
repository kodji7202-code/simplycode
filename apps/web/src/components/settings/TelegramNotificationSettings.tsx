import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import type { TelegramChatSummary } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import { msg, T, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { ScopedSwitch } from "./ScopedSwitch";
import { SecretInput } from "./SecretInput";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsWriteAllowed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const NOTIFY_SWITCHES = [
  { key: "notifyOnCompletion", title: msg("When a thread finishes") },
  { key: "notifyOnFailure", title: msg("When a thread fails") },
  { key: "notifyOnApproval", title: msg("When a thread needs your approval") },
  { key: "notifyOnInput", title: msg("When a thread needs your input") },
  { key: "notifyOnWorkflows", title: msg("For pipelines and workflows") },
] as const;

type CallState =
  | { readonly status: "idle" }
  | { readonly status: "running" }
  | { readonly status: "failed"; readonly message: string };

const IDLE: CallState = { status: "idle" };

export function TelegramNotificationSettings() {
  const gt = useGT();
  const { environment, scope } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsScopeNotice inline target="environment" targetId="telegram-notifications">
        {gt("Choose one environment to configure its Telegram notifications.")}
      </SettingsScopeNotice>
    );
  }
  return <TelegramNotificationForm key={environment.environmentId} />;
}

function TelegramNotificationForm() {
  const gt = useGT();
  const messages = useMessages();
  const setting = useSearchableSetting();
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId;
  const saved = useScopedSettings((settings) => settings.telegramNotifications);
  const updateSettings = useUpdateScopedSettings();
  const canWrite = useScopedSettingsWriteAllowed();
  const canCall = useAtomValue(
    serverEnvironment.telegramTest.permissionAtom(environmentId ?? null),
  );
  const telegramTest = useAtomCommand(serverEnvironment.telegramTest);
  const telegramDetectChats = useAtomCommand(serverEnvironment.telegramDetectChats);
  const [tokenDraft, setTokenDraft] = useState<string | null>(null);
  const [detected, setDetected] = useState<ReadonlyArray<TelegramChatSummary> | null>(null);
  const [detectState, setDetectState] = useState<CallState>(IDLE);
  const [testState, setTestState] = useState<CallState & { sent?: boolean }>(IDLE);

  const patch = (patch: Parameters<typeof updateSettings>[0]) => updateSettings(patch);
  const tokenForCall =
    tokenDraft !== null && tokenDraft.trim() !== "" ? { botToken: tokenDraft.trim() } : {};
  const tokenConfigured = tokenDraft !== null ? tokenDraft.trim() !== "" : saved.botToken !== "";
  const chatId = saved.chatId;

  const detect = async () => {
    if (!environmentId || detectState.status === "running") return;
    setDetectState({ status: "running" });
    const response = await telegramDetectChats({
      environmentId,
      input: tokenForCall,
    });
    if (response._tag === "Success") {
      setDetectState(IDLE);
      setDetected(response.value.chats);
      return;
    }
    setDetected(null);
    const error = Cause.squash(response.cause);
    setDetectState({
      status: "failed",
      message:
        (error instanceof Error && (errorDisplayMessage(error, messages) ?? error.message)) ||
        gt("Could not reach the server"),
    });
  };

  const sendTest = async () => {
    if (!environmentId || testState.status === "running") return;
    setTestState({ status: "running" });
    const response = await telegramTest({
      environmentId,
      input: { ...tokenForCall, chatId },
    });
    if (response._tag === "Success") {
      setTestState({ ...IDLE, sent: true });
      return;
    }
    const error = Cause.squash(response.cause);
    setTestState({
      status: "failed",
      message:
        (error instanceof Error && (errorDisplayMessage(error, messages) ?? error.message)) ||
        gt("Could not reach the server"),
    });
  };

  return (
    <>
      <SettingsRow
        {...setting("telegram-notifications")}
        description={
          <T>
            Send a Telegram message when a thread finishes, fails, or needs you. Works while the
            server runs, even with this app closed.
          </T>
        }
        control={
          <ScopedSwitch
            settingKeys={["telegramNotifications"]}
            checked={saved.enabled}
            disabled={!canWrite}
            onCheckedChange={(checked) => patch({ telegramNotifications: { enabled: checked } })}
            aria-label={gt("Telegram notifications")}
          />
        }
      />
      <SettingsRow
        title={<T>Bot token</T>}
        description={<T>The token @BotFather gave you. Saved on the server, never shown again.</T>}
        control={
          <SecretInput
            size="sm"
            className="w-full sm:w-56"
            configured={saved.botToken !== ""}
            value={tokenDraft ?? ""}
            disabled={!canWrite}
            aria-label={gt("Telegram bot token")}
            onCommit={(next) => {
              setTokenDraft(next);
              patch({ telegramNotifications: { botToken: next } });
            }}
          />
        }
      />
      <SettingsRow
        title={<T>Chat ID</T>}
        description={
          detected !== null && detected.length === 0
            ? gt("Send any message to your bot in Telegram, then press Detect again.")
            : gt("The chat your bot messages. Detect lists the chats it has seen.")
        }
        control={
          <div className="flex w-full items-center gap-2 sm:w-72">
            <DraftInput
              size="sm"
              className="min-w-0 flex-1"
              value={chatId}
              disabled={!canWrite}
              aria-label={gt("Telegram chat ID")}
              placeholder={gt("Chat ID")}
              onCommit={(next) => patch({ telegramNotifications: { chatId: next.trim() } })}
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={
                !canCall || detectState.status === "running" || (!tokenConfigured && !tokenDraft)
              }
              onClick={() => void detect()}
            >
              {detectState.status === "running" ? gt("Detecting…") : gt("Detect")}
            </Button>
          </div>
        }
      />
      {detectState.status === "failed" && (
        <p role="alert" className="px-4 text-xs text-destructive sm:px-5">
          {detectState.message}
        </p>
      )}
      {detected !== null && detected.length > 0 && (
        <SettingsRow
          title={<T>Pick a chat</T>}
          control={
            <Select
              value=""
              onValueChange={(id) => {
                if (id !== null) patch({ telegramNotifications: { chatId: id } });
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-72" aria-label={gt("Detected chats")}>
                <SelectValue>{gt("Choose a chat")}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {detected.map((chat) => (
                  <SelectItem key={chat.id} hideIndicator value={chat.id}>
                    {chat.title} · {chat.id}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          }
        />
      )}
      {NOTIFY_SWITCHES.map(({ key, title }) => (
        <SettingsRow
          key={key}
          title={messages(title)}
          control={
            <ScopedSwitch
              settingKeys={["telegramNotifications"]}
              checked={saved[key]}
              disabled={!canWrite}
              onCheckedChange={(checked) => patch({ telegramNotifications: { [key]: checked } })}
              aria-label={messages(title)}
            />
          }
        />
      ))}
      <SettingsRow
        title={<T>Test message</T>}
        description={
          testState.status === "failed" ? (
            testState.message
          ) : testState.sent === true ? (
            <T>Test message sent.</T>
          ) : (
            <T>Send a Telegram message to check the token and chat.</T>
          )
        }
        control={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={
              !canCall || testState.status === "running" || !tokenConfigured || chatId.trim() === ""
            }
            onClick={() => void sendTest()}
          >
            {testState.status === "running" ? gt("Sending…") : gt("Send test message")}
          </Button>
        }
      />
    </>
  );
}
