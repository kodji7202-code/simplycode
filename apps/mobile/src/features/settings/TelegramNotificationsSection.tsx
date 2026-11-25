import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AuthSettingsWriteScope, type TelegramChatSummary } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { type ReactNode, useState } from "react";
import { ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";
import { Sheet } from "../../components/ui/Sheet";
import { m as resolveMessage } from "../../i18n/messages";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

const NOTIFY_SWITCHES = [
  { key: "notifyOnCompletion", label: msg("When a thread finishes") },
  { key: "notifyOnFailure", label: msg("When a thread fails") },
  { key: "notifyOnApproval", label: msg("When a thread needs your approval") },
  { key: "notifyOnInput", label: msg("When a thread needs your input") },
  { key: "notifyOnWorkflows", label: msg("For pipelines and workflows") },
] as const;

const failureMessage = (result: { readonly cause: Cause.Cause<unknown> }) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error
    ? (errorDisplayMessage(error, resolveMessage) ?? error.message)
    : resolveMessage(msg("Could not reach the server."));
};

export function TelegramNotificationsSection() {
  const { environments } = useEnvironments();
  const connected = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" && environment.serverConfig !== null,
  );
  if (connected.length === 0) return null;
  return (
    <>
      {connected.map((environment) => (
        <TelegramEnvironmentSection
          key={environment.environmentId}
          environment={environment}
          single={connected.length === 1}
        />
      ))}
    </>
  );
}

function TelegramEnvironmentSection({
  environment,
  single,
}: {
  readonly environment: EnvironmentPresentation;
  readonly single: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const settings = environment.serverConfig!.settings.telegramNotifications;
  const environmentId = environment.environmentId;
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "telegram settings update",
    reportFailure: true,
  });
  const telegramTest = useAtomCommand(serverEnvironment.telegramTest, {
    label: "telegram test message",
    reportFailure: false,
  });
  const [sheet, setSheet] = useState<"token" | "chat" | null>(null);
  const [sending, setSending] = useState(false);
  const configured = settings.botToken !== "";

  const patch = (patch: Record<string, unknown>) =>
    void updateSettings({
      environmentId,
      input: { patch: { telegramNotifications: patch } },
    });

  const sendTest = async () => {
    if (sending) return;
    setSending(true);
    const result = await telegramTest({ environmentId, input: {} });
    setSending(false);
    if (result._tag === "Success") {
      Dialog.alert(gt("Telegram"), gt("Test message sent."));
    } else {
      Dialog.alert(gt("Telegram"), failureMessage(result));
    }
  };

  return (
    <SettingsSection
      title={single ? gt("Telegram") : gt("Telegram · {label}", { label: environment.label })}
      footer={gt(
        "Create a bot with @BotFather in Telegram, paste its token, message your bot once, then press Detect. The server sends thread and pipeline updates to the chat, even while this app is closed.",
      )}
    >
      <SettingsSwitchRow
        icon="bell.badge"
        label={gt("Telegram notifications")}
        subtitle={gt("Message the chat when a thread finishes, fails, or needs you")}
        value={settings.enabled}
        disabled={!canWrite}
        onValueChange={(value) => patch({ enabled: value })}
      />
      <Separated>
        <ListActionRow
          label={gt("Bot token")}
          description={configured ? gt("Saved") : gt("Not set")}
          disabled={!canWrite}
          onPress={() => setSheet("token")}
        />
      </Separated>
      <Separated>
        <ListActionRow
          label={gt("Chat ID")}
          description={settings.chatId !== "" ? settings.chatId : gt("Not set")}
          disabled={!canWrite}
          onPress={() => setSheet("chat")}
        />
      </Separated>
      {NOTIFY_SWITCHES.map(({ key, label }) => (
        <Separated key={key}>
          <SettingsSwitchRow
            label={m(label)}
            value={settings[key]}
            disabled={!canWrite || !settings.enabled}
            onValueChange={(value) => patch({ [key]: value })}
          />
        </Separated>
      ))}
      <Separated>
        <ListActionRow
          label={sending ? gt("Sending…") : gt("Send test message")}
          loading={sending}
          disabled={!canWrite || !configured || settings.chatId.trim() === ""}
          onPress={() => void sendTest()}
        />
      </Separated>
      {sheet === "token" && (
        <TelegramTokenSheet environment={environment} onClose={() => setSheet(null)} />
      )}
      {sheet === "chat" && (
        <TelegramChatSheet environment={environment} onClose={() => setSheet(null)} />
      )}
    </SettingsSection>
  );
}

/** A hairline above a row that has no `separated` prop of its own. */
function Separated({ children }: { readonly children: ReactNode }) {
  return <View className="border-t border-border-subtle">{children}</View>;
}

function TelegramTokenSheet({
  environment,
  onClose,
}: {
  readonly environment: EnvironmentPresentation;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const environmentId = environment.environmentId;
  const configured = environment.serverConfig!.settings.telegramNotifications.botToken !== "";
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "telegram bot token update",
    reportFailure: true,
  });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async (token: string) => {
    if (saving) return;
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { telegramNotifications: { botToken: token } } },
    });
    setSaving(false);
    if (result._tag === "Success") onClose();
  };
  return (
    <Sheet title={gt("Telegram bot token")} onClose={onClose}>
      <ScrollView contentContainerClassName="gap-4 px-5 pt-2">
        <Text className="text-sm text-foreground-muted">
          <T>The token @BotFather gave you. It is saved on the server and never shown again.</T>
        </Text>
        <ListSection>
          <View className="px-4 py-3">
            <TextInput
              accessibilityLabel={gt("Telegram bot token")}
              placeholder={configured ? gt("Saved · enter a new one to replace") : gt("Bot token")}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              importantForAutofill="no"
              editable={!saving}
              returnKeyType="done"
              onSubmitEditing={() => void save(draft.trim())}
              value={draft}
              onChangeText={setDraft}
              className="rounded-lg bg-background px-3 py-2 text-foreground"
            />
          </View>
          <Separated>
            <ListActionRow
              label={gt("Save token")}
              loading={saving}
              disabled={draft.trim() === ""}
              onPress={() => void save(draft.trim())}
            />
          </Separated>
        </ListSection>
      </ScrollView>
    </Sheet>
  );
}

function TelegramChatSheet({
  environment,
  onClose,
}: {
  readonly environment: EnvironmentPresentation;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const environmentId = environment.environmentId;
  const saved = environment.serverConfig!.settings.telegramNotifications;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "telegram chat update",
    reportFailure: true,
  });
  const telegramDetectChats = useAtomCommand(serverEnvironment.telegramDetectChats, {
    label: "telegram detect chats",
    reportFailure: false,
  });
  const [draft, setDraft] = useState(saved.chatId);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [chats, setChats] = useState<ReadonlyArray<TelegramChatSummary> | null>(null);

  const saveChatId = async (chatId: string) => {
    if (saving) return;
    setSaving(true);
    const result = await updateSettings({
      environmentId,
      input: { patch: { telegramNotifications: { chatId } } },
    });
    setSaving(false);
    if (result._tag === "Success") onClose();
  };

  const detect = async () => {
    if (detecting) return;
    setDetecting(true);
    const result = await telegramDetectChats({ environmentId, input: {} });
    setDetecting(false);
    if (result._tag === "Success") {
      setChats(result.value.chats);
    } else {
      setChats(null);
      Dialog.alert(gt("Telegram"), failureMessage(result));
    }
  };

  return (
    <Sheet title={gt("Telegram chat")} onClose={onClose}>
      <ScrollView contentContainerClassName="gap-4 px-5 pt-2">
        <Text className="text-sm text-foreground-muted">
          <T>
            The chat your bot messages. Message your bot once in Telegram, then press Detect to pick
            it.
          </T>
        </Text>
        <ListSection>
          <View className="px-4 py-3">
            <TextInput
              accessibilityLabel={gt("Telegram chat ID")}
              placeholder={gt("Chat ID")}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              keyboardType="numbers-and-punctuation"
              editable={!saving}
              returnKeyType="done"
              onSubmitEditing={() => void saveChatId(draft.trim())}
              value={draft}
              onChangeText={setDraft}
              className="rounded-lg bg-background px-3 py-2 text-foreground"
            />
          </View>
          <Separated>
            <ListActionRow
              label={gt("Save chat ID")}
              loading={saving}
              disabled={draft.trim() === saved.chatId}
              onPress={() => void saveChatId(draft.trim())}
            />
          </Separated>
        </ListSection>
        <ListSection
          title={gt("Detected chats")}
          footer={
            chats !== null && chats.length === 0
              ? gt("Send any message to your bot in Telegram, then press Detect again.")
              : undefined
          }
        >
          <ListActionRow
            label={detecting ? gt("Detecting…") : gt("Detect")}
            loading={detecting}
            onPress={() => void detect()}
          />
          {(chats ?? []).map((chat) => (
            <Separated key={chat.id}>
              <ListChoiceRow
                label={chat.title}
                description={chat.id}
                selected={chat.id === saved.chatId}
                onPress={() => void saveChatId(chat.id)}
              />
            </Separated>
          ))}
        </ListSection>
      </ScrollView>
    </Sheet>
  );
}
