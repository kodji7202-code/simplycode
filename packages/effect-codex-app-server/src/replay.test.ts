import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, expect, it } from "@effect/vitest";

import * as CodexClient from "./client.ts";
import { layerReplay, type CodexAppServerReplayTranscript } from "./replay.ts";

const transcript = (
  entries: CodexAppServerReplayTranscript["entries"],
): CodexAppServerReplayTranscript => ({
  provider: "codex",
  protocol: "codex.app-server",
  version: "0.120.0",
  scenario: "brand-mapping",
  entries,
});

const withReplayClient = <A, E>(
  recording: CodexAppServerReplayTranscript,
  run: (client: CodexClient.CodexAppServerClient["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(layerReplay(recording), scope);
    return yield* Effect.gen(function* () {
      const client = yield* CodexClient.CodexAppServerClient;
      return yield* run(client);
    }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));
  });

it.effect(
  "matches an initialize frame whose clientInfo has the fork's name, title, and version",
  () =>
    withReplayClient(
      transcript([
        {
          type: "expect_outbound",
          label: "initialize",
          frame: {
            id: 1,
            method: "initialize",
            params: {
              capabilities: { experimentalApi: true, optOutNotificationMethods: null },
              clientInfo: { name: "T3 Code", title: "T3 Code", version: "0.0.44" },
            },
          },
        },
        {
          type: "emit_inbound",
          label: "initialize",
          frame: {
            id: 1,
            result: {
              userAgent: "replay-agent",
              codexHome: "/tmp/codex",
              platformFamily: "unix",
              platformOs: "linux",
            },
          },
        },
      ]),
      (client) =>
        Effect.gen(function* () {
          const initialized = yield* client.request("initialize", {
            clientInfo: { name: "SimplyCode", title: "SimplyCode", version: "0.1.11" },
            capabilities: { experimentalApi: true, optOutNotificationMethods: null },
          });
          assert.equal(initialized.userAgent, "replay-agent");
        }),
    ),
);

it.effect("maps the brand token in turn/start input text back to the recording", () =>
  withReplayClient(
    transcript([
      {
        type: "expect_outbound",
        label: "turn/start",
        frame: {
          id: 1,
          method: "turn/start",
          params: {
            input: [
              {
                type: "text",
                text: '[T3 Code: the agent in T3 thread "thread:parent" sent this message, not the user.]\n\nInspect the boundary.',
              },
            ],
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/start",
        frame: { id: 1, result: { turn: { id: "turn-1", status: "inProgress" } } },
      },
    ]),
    (client) =>
      Effect.gen(function* () {
        const result = yield* client.raw.request("turn/start", {
          input: [
            {
              type: "text",
              text: '[SimplyCode: the agent in T3 thread "thread:parent" sent this message, not the user.]\n\nInspect the boundary.',
            },
          ],
        });
        assert.deepEqual(result, { turn: { id: "turn-1", status: "inProgress" } });
      }),
  ),
);

it.effect("still mismatches a genuinely different text", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      withReplayClient(
        transcript([
          {
            type: "expect_outbound",
            label: "turn/start",
            frame: {
              id: 1,
              method: "turn/start",
              params: {
                input: [{ type: "text", text: "Inspect the boundary." }],
              },
            },
          },
        ]),
        (client) =>
          Effect.gen(function* () {
            yield* client.raw.request("turn/start", {
              input: [{ type: "text", text: "Delete the boundary instead." }],
            });
            // The mismatch is recorded asynchronously; give the transport a beat.
            return yield* client.awaitTermination;
          }),
      ),
    );
    assert.equal(Exit.isFailure(exit), true);
    if (Exit.isFailure(exit)) {
      expect(exit.cause.toString()).toContain("CodexAppServerReplayFrameMismatchError");
    }
  }),
);
