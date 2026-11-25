import type { TelegramChatSummary } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

const API_BASE = "https://api.telegram.org/bot";
const REQUEST_TIMEOUT = Duration.seconds(10);
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 30_000;
const NETWORK_BACKOFF_MS = [1_000, 2_000];
const MAX_MESSAGE_LENGTH = 4_000;
const GET_UPDATES_LIMIT = "100";

export class TelegramError extends Schema.TaggedError<TelegramError>()("TelegramError", {
  message: Schema.String,
}) {}

// The request URL holds the bot token; nothing here may put a URL or the
// HttpClientError carrying it into a message, log, or span attribute — client
// spans record url.full, so `attempt` disables client tracing outright.
const envelope = Schema.Struct({
  ok: Schema.Boolean,
  description: Schema.optional(Schema.String),
  parameters: Schema.optional(Schema.Struct({ retry_after: Schema.optional(Schema.Number) })),
});

/** The envelope's failure, when the request should not be retried any more. */
const envelopeError = (body: unknown, status: number): TelegramError | null => {
  const meta = Option.getOrNull(Schema.decodeUnknownOption(envelope)(body));
  if (meta?.ok === false) {
    return new TelegramError({
      message: meta.description ?? `Telegram rejected the request (HTTP ${status}).`,
    });
  }
  if (status !== 200) {
    return new TelegramError({
      message: meta?.description ?? `Telegram rejected the request (HTTP ${status}).`,
    });
  }
  return null;
};

const TelegramMessage = Schema.Struct({
  chat: Schema.Struct({
    id: Schema.Union([Schema.String, Schema.Number]),
    type: Schema.String,
    title: Schema.optional(Schema.String),
    username: Schema.optional(Schema.String),
    first_name: Schema.optional(Schema.String),
    last_name: Schema.optional(Schema.String),
  }),
});

const TelegramUpdate = Schema.Struct({
  message: Schema.optional(TelegramMessage),
  edited_message: Schema.optional(TelegramMessage),
  channel_post: Schema.optional(TelegramMessage),
  my_chat_member: Schema.optional(TelegramMessage),
});

const GetUpdatesResult = Schema.Struct({
  ok: Schema.Boolean,
  result: Schema.Array(TelegramUpdate),
});

export class TelegramBotApi extends Context.Service<
  TelegramBotApi,
  {
    readonly sendMessage: (input: {
      readonly token: Redacted.Redacted;
      readonly chatId: string;
      readonly text: string;
    }) => Effect.Effect<void, TelegramError>;
    readonly listChats: (input: {
      readonly token: Redacted.Redacted;
    }) => Effect.Effect<ReadonlyArray<TelegramChatSummary>, TelegramError>;
  }
>()("simplycode/notifications/TelegramBotApi") {}

type TelegramChat = (typeof TelegramMessage.Type)["chat"];

const chatTitle = (chat: TelegramChat): string => {
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim();
  return chat.title ?? chat.username ?? (name === "" ? String(chat.id) : name);
};

// Latest sighting wins, most recent first.
const collectChats = (
  updates: ReadonlyArray<typeof TelegramUpdate.Type>,
): ReadonlyArray<TelegramChatSummary> => {
  const byId = new Map<string, TelegramChatSummary>();
  for (const update of updates) {
    const chat =
      update.message?.chat ??
      update.edited_message?.chat ??
      update.channel_post?.chat ??
      update.my_chat_member?.chat;
    if (!chat) continue;
    const id = String(chat.id);
    byId.delete(id);
    byId.set(id, { id, title: chatTitle(chat), type: chat.type });
  }
  return [...byId.values()].reverse();
};

const UNREADABLE = new TelegramError({ message: "Telegram returned an unreadable response." });
const decodeGetUpdatesResult = Schema.decodeUnknownEffect(GetUpdatesResult);

const make = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;

  // One attempt; retryable outcomes name their delay, `null` asking for the
  // caller's backoff. Nothing here puts the request (its URL holds the token)
  // into a surfaced error.
  const attempt = Effect.fnUntraced(function* (
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.fn.Return<
    | { readonly kind: "ok"; readonly body: unknown; readonly status: number }
    | { readonly kind: "retry"; readonly delayMs: number | null }
    | { readonly kind: "final"; readonly error: TelegramError },
    never,
    never
  > {
    const timed = yield* http.execute(request).pipe(
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.timeoutOption(REQUEST_TIMEOUT),
      Effect.result,
    );
    if (Result.isFailure(timed)) {
      return { kind: "retry", delayMs: null };
    }
    if (Option.isNone(timed.success)) {
      return {
        kind: "final",
        error: new TelegramError({ message: "Telegram did not respond within 10 seconds." }),
      };
    }
    const response = timed.success.value;
    const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
    if (response.status === 429) {
      const meta = Option.getOrNull(Schema.decodeUnknownOption(envelope)(body));
      return {
        kind: "retry",
        delayMs: Math.min(
          Math.max(Math.round((meta?.parameters?.retry_after ?? 1) * 1000), 500),
          MAX_RETRY_AFTER_MS,
        ),
      };
    }
    if (response.status >= 500) {
      return { kind: "retry", delayMs: null };
    }
    return { kind: "ok", body, status: response.status };
  });

  const call = Effect.fn("TelegramBotApi.call")(function* <A>(
    request: HttpClientRequest.HttpClientRequest,
    decode: (body: unknown) => Effect.Effect<A, TelegramError>,
  ) {
    let delayMs: number | null = null;
    for (let index = 0; index < MAX_ATTEMPTS; index++) {
      if (delayMs !== null) {
        yield* Effect.sleep(delayMs);
      }
      const outcome = yield* attempt(request);
      if (outcome.kind === "final") {
        return yield* outcome.error;
      }
      if (outcome.kind === "ok") {
        const error = envelopeError(outcome.body, outcome.status);
        if (error !== null) {
          return yield* error;
        }
        return yield* decode(outcome.body);
      }
      delayMs = outcome.delayMs ?? NETWORK_BACKOFF_MS[index] ?? NETWORK_BACKOFF_MS.at(-1)!;
    }
    return yield* new TelegramError({
      message: "Telegram could not be reached after several attempts.",
    });
  });

  const sendMessage: TelegramBotApi["Service"]["sendMessage"] = Effect.fn(
    "TelegramBotApi.sendMessage",
  )(function* (input) {
    const request = HttpClientRequest.post(
      `${API_BASE}${Redacted.value(input.token)}/sendMessage`,
    ).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        chat_id: input.chatId,
        text:
          input.text.length > MAX_MESSAGE_LENGTH
            ? `${input.text.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
            : input.text,
        disable_web_page_preview: true,
      }),
    );
    yield* call(request, () => Effect.void);
  });

  const listChats: TelegramBotApi["Service"]["listChats"] = Effect.fn("TelegramBotApi.listChats")(
    function* (input) {
      const request = HttpClientRequest.get(
        `${API_BASE}${Redacted.value(input.token)}/getUpdates`,
      ).pipe(HttpClientRequest.setUrlParam("limit", GET_UPDATES_LIMIT));
      return yield* call(request, (body) =>
        decodeGetUpdatesResult(body).pipe(
          Effect.map((decoded) => collectChats(decoded.result)),
          Effect.mapError(() => UNREADABLE),
        ),
      );
    },
  );

  return TelegramBotApi.of({ sendMessage, listChats });
});

export const layer = Layer.effect(TelegramBotApi, make);
