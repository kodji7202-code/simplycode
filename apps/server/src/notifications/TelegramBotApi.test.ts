import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { layer as telegramBotApiLayer, TelegramBotApi, TelegramError } from "./TelegramBotApi.ts";

const TOKEN = Redacted.make("123:secret-token");

interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly body: string | undefined;
}

const fakeClient = (
  calls: RecordedCall[],
  responses: ReadonlyArray<{ readonly status: number; readonly body?: unknown }>,
) => {
  let index = 0;
  return HttpClient.make((request) => {
    const step = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    const body = request.body;
    calls.push({
      method: request.method,
      url: request.url,
      body: body._tag === "Uint8Array" ? body.text : undefined,
    });
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(step.body ?? { ok: true }), {
          status: step.status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });
};

const layerFor = (
  calls: RecordedCall[],
  responses: ReadonlyArray<{ readonly status: number; readonly body?: unknown }>,
) =>
  telegramBotApiLayer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, fakeClient(calls, responses))),
  );

it.effect("posts the message JSON to the bot's sendMessage path", () => {
  const calls: RecordedCall[] = [];
  return Effect.gen(function* () {
    const api = yield* TelegramBotApi;
    yield* api.sendMessage({ token: TOKEN, chatId: "-100", text: "hello" });
    assert.lengthOf(calls, 1);
    const call = calls[0]!;
    assert.equal(call.method, "POST");
    assert.equal(call.url, "https://api.telegram.org/bot123:secret-token/sendMessage");
    assert.deepEqual(JSON.parse(call.body!), {
      chat_id: "-100",
      text: "hello",
      disable_web_page_preview: true,
    });
  }).pipe(Effect.provide(layerFor(calls, [{ status: 200 }])));
});

it.effect("truncates the text at 4000 characters", () => {
  const calls: RecordedCall[] = [];
  return Effect.gen(function* () {
    const api = yield* TelegramBotApi;
    yield* api.sendMessage({ token: TOKEN, chatId: "1", text: "x".repeat(5000) });
    const sent = JSON.parse(calls[0]!.body!).text as string;
    assert.lengthOf(sent, 4000);
    assert.isTrue(sent.endsWith("…"));
  }).pipe(Effect.provide(layerFor(calls, [{ status: 200 }])));
});

it.effect("honors retry_after on a 429 and then sends", () => {
  const calls: RecordedCall[] = [];
  return Effect.gen(function* () {
    const api = yield* TelegramBotApi;
    const fiber = yield* api
      .sendMessage({ token: TOKEN, chatId: "1", text: "hi" })
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("2 seconds");
    yield* Fiber.join(fiber);
    assert.lengthOf(calls, 2);
    assert.equal(calls[1]!.method, "POST");
  }).pipe(
    Effect.provide(
      layerFor(calls, [
        { status: 429, body: { ok: false, parameters: { retry_after: 2 } } },
        { status: 200 },
      ]),
    ),
  );
});

it.effect("surfaces Telegram's description and never the token", () => {
  const calls: RecordedCall[] = [];
  return Effect.gen(function* () {
    const api = yield* TelegramBotApi;
    const error = yield* api
      .sendMessage({ token: TOKEN, chatId: "1", text: "hi" })
      .pipe(Effect.flip);
    assert.instanceOf(error, TelegramError);
    assert.equal(error.message, "chat not found");
    assert.notInclude(error.message, "secret-token");
  }).pipe(
    Effect.provide(
      layerFor(calls, [{ status: 400, body: { ok: false, description: "chat not found" } }]),
    ),
  );
});

it.effect("keeps the token-bearing URL out of client spans", () => {
  const calls: RecordedCall[] = [];
  const recorded: Array<{ name: string; attributes: Record<string, unknown> }> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        recorded.push({ name: span.name, attributes: Object.fromEntries(span.attributes) });
      };
      return span;
    },
  });
  return Effect.gen(function* () {
    const api = yield* TelegramBotApi;
    yield* api
      .sendMessage({ token: TOKEN, chatId: "1", text: "hi" })
      .pipe(Effect.withTracer(tracer));
    // The sendMessage/call function spans prove the tracer was live; none may
    // carry the token through the client request's url.full.
    assert.isNotEmpty(recorded);
    assert.notInclude(JSON.stringify(recorded), "secret-token");
  }).pipe(Effect.provide(layerFor(calls, [{ status: 200 }])));
});

it.effect("collects distinct chats from getUpdates, most recent first", () => {
  const calls: RecordedCall[] = [];
  return Effect.gen(function* () {
    const api = yield* TelegramBotApi;
    const chats = yield* api.listChats({ token: TOKEN });
    assert.lengthOf(calls, 1);
    assert.equal(calls[0]!.method, "GET");
    assert.include(calls[0]!.url, "/bot123:secret-token/getUpdates");
    assert.deepEqual(chats, [
      { id: "-100200", title: "Team", type: "supergroup" },
      { id: "42", title: "ada", type: "private" },
    ]);
  }).pipe(
    Effect.provide(
      layerFor(calls, [
        {
          status: 200,
          body: {
            ok: true,
            result: [
              {
                message: {
                  chat: {
                    id: 42,
                    type: "private",
                    first_name: "Ada",
                    last_name: "Lovelace",
                  },
                },
              },
              { message: { chat: { id: 42, type: "private", username: "ada" } } },
              { message: { chat: { id: -100200, type: "supergroup", title: "Team" } } },
              { update_without_message: true },
            ],
          },
        },
      ]),
    ),
  );
});

it.effect("maps an unreadable response to a TelegramError without the token", () => {
  const calls: RecordedCall[] = [];
  return Effect.gen(function* () {
    const api = yield* TelegramBotApi;
    const error = yield* api.listChats({ token: TOKEN }).pipe(Effect.flip);
    assert.instanceOf(error, TelegramError);
    assert.equal(error.message, "Telegram returned an unreadable response.");
    assert.notInclude(error.message, "secret-token");
  }).pipe(
    Effect.provide(layerFor(calls, [{ status: 200, body: { ok: true, result: "not-an-array" } }])),
  );
});

it.effect("gives up with a clear error after three failed attempts", () => {
  const calls: RecordedCall[] = [];
  return Effect.gen(function* () {
    const api = yield* TelegramBotApi;
    const fiber = yield* api
      .sendMessage({ token: TOKEN, chatId: "1", text: "hi" })
      .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("10 seconds");
    const error = yield* Fiber.join(fiber);
    assert.lengthOf(calls, 3);
    assert.instanceOf(error, TelegramError);
    assert.equal(error.message, "Telegram could not be reached after several attempts.");
    assert.notInclude(error.message, "secret-token");
  }).pipe(Effect.provide(layerFor(calls, [{ status: 503, body: { ok: false } }])));
});
