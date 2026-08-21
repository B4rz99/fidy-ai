import { Schema } from "effect";

/** Stable lowercase UUID identity for one Fidy-owned hosted conversational session. */
export const HostedAgentSessionId = Schema.String.check(
  Schema.isUUID(),
  Schema.makeFilter<string>((value) =>
    value === value.toLowerCase() ? undefined : "Expected canonical lowercase UUID spelling"
  )
)
  .pipe(Schema.brand("HostedAgentSessionId"))
  .annotate({ identifier: "HostedAgentSessionId" });
export type HostedAgentSessionId = typeof HostedAgentSessionId.Type;
