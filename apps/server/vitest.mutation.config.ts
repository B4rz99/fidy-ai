import { mergeConfig } from "vitest/config";
import core from "./vitest.core.config";

export default mergeConfig(core, { test: { isolate: true } });
