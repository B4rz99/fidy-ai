import { Clock, Effect } from "effect";
import { localCanonicalReadBearer } from "./contract";

export const currentMillis = (): number => Effect.runSync(Clock.currentTimeMillis);

export const resolveLocalCanonicalReadBearer = (development: boolean): string =>
  development ? localCanonicalReadBearer : "";
