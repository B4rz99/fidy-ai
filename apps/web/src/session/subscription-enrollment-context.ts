import { Option } from "effect";
import { createContext, useContext } from "react";
import type { SubscriptionEnrollmentClient } from "@/transport/client";

export const SubscriptionEnrollmentContext: React.Context<
  Option.Option<SubscriptionEnrollmentClient>
> = createContext(Option.none());

export const useSubscriptionEnrollmentClient = (): SubscriptionEnrollmentClient => {
  const client = useContext(SubscriptionEnrollmentContext);
  if (Option.isNone(client)) {
    throw new Error(
      "useSubscriptionEnrollmentClient must be used within SubscriptionEnrollmentLifetime"
    );
  }
  return client.value;
};
