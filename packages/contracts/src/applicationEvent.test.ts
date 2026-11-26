import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ApplicationEventMetadata } from "./applicationEvent.ts";

const decodeMetadata = Schema.decodeUnknownSync(ApplicationEventMetadata);

describe("ApplicationEventMetadata", () => {
  it("ignores the retired client-origin key sent by older clients", () => {
    expect(
      decodeMetadata({
        deferredTurn: true,
        origin: { surface: "web", appVersion: "0.0.44" },
      }),
    ).toEqual({ deferredTurn: true });
  });
});
