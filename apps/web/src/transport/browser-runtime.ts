import { Layer, ManagedRuntime } from "effect";

export const browserRuntime = ManagedRuntime.make(Layer.empty);
