import { Clock, Layer, ManagedRuntime } from "effect";
import { localCanonicalReadBearer } from "./contract";

const boundaryRuntime = ManagedRuntime.make(Layer.empty);

export const currentMillis = (): number => boundaryRuntime.runSync(Clock.currentTimeMillis);

export const resolveLocalCanonicalReadBearer = (development: boolean): string =>
  development ? localCanonicalReadBearer : "";
