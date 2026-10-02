import { Clock, Effect } from "effect";

/** Server-observed time for native operations; never a caller-supplied deadline. */
export const currentMillis = (): number => Effect.runSync(Clock.currentTimeMillis);
