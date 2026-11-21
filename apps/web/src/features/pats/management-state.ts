import { Data } from "effect";

import type { ActivePATList } from "@/transport/client";

export type ActivePATManagementState = Data.TaggedEnum<{
  Initial: {};
  Loading: {};
  LoadFailure: {
    readonly boundaryFailure: boolean;
    readonly onRetry: () => void;
    readonly waiting: boolean;
  };
  Ready: {
    readonly result: ActivePATList;
    readonly onRetry: () => void;
    readonly refreshing: boolean;
    readonly refreshFailed: boolean;
  };
}>;

export const ActivePATManagementState = Data.taggedEnum<ActivePATManagementState>();
