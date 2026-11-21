import { Data } from "effect";
import type { SubscriptionStatus } from "@/transport/client";

export type StandingViewState = Data.TaggedEnum<{
  Initial: {};
  Failure: {};
  Ready: Readonly<{ standing: SubscriptionStatus }>;
}>;

export const StandingViewState = Data.taggedEnum<StandingViewState>();
