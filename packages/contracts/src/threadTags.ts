import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Tags match by exact spelling and case after trimming. */
export const ThreadTag = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value) =>
    /[\p{Cc}]/u.test(value) ? "A thread tag must be a single line of text." : true,
  ),
);
export type ThreadTag = typeof ThreadTag.Type;

/** Tags read back from storage or a peer. Lenient so a later tag rule never fails a whole thread. */
export const StoredThreadTags = Schema.Array(Schema.String).pipe(
  Schema.catchDecoding(() => Effect.succeedSome([])),
);

/** `bot:<botId>` marks the thread a bot's delegated run produced (`botThreadTag` in bot.ts). */
export const BOT_THREAD_TAG_PREFIX = "bot:";

export const hasBotThreadTag = (tags: ReadonlyArray<string> | undefined): boolean =>
  tags?.some((tag) => tag.startsWith(BOT_THREAD_TAG_PREFIX)) === true;
