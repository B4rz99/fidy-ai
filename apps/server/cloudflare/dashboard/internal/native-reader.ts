import { Schema } from "effect";
import {
  type NativeDashboardReader,
  type NativeDashboardReaderConfiguration,
  NativeDashboardResult,
} from "../contract";

export const nativeReader =
  (input: NativeDashboardReaderConfiguration): NativeDashboardReader =>
  (request) => {
    try {
      return input
        .nativeCall(() =>
          input.store.dashboard({ manifest: input.manifest, epoch: input.epoch, ...request })
        )
        .then(Schema.decodeUnknownSync(NativeDashboardResult));
    } catch (cause) {
      return Promise.reject(cause);
    }
  };
