import { Effect } from "effect";
import {
  type AgentRetention,
  type AgentService,
  type AgentServiceInput,
  AgentUnavailable,
} from "./contract";
import { makeHostedService } from "./internal/service";
import { sweepProactiveTranscript } from "./internal/proactive-transcript";
import { sweepHostedTurns } from "./internal/hosted-turn-sweep";

/** Construct the complete hosted workflow inside the existing User coordinator; construction grants no subject or Consent authority. */
export const makeAgentService = (input: AgentServiceInput): AgentService => {
  const service = makeHostedService(input);
  return {
    accept: (request) => service.accept(request),
    recover: () =>
      Effect.runPromise(
        Effect.tryPromise({ try: service.recover, catch: () => new AgentUnavailable() })
      ),
  };
};
/** Construct only fixed-policy, bounded recovery and retention, without model, channel or admission authority. */
export const makeAgentRetention = ({ db }: Readonly<{ db: D1Database }>): AgentRetention => ({
  sweep: (now) =>
    Effect.partition(
      [sweepHostedTurns({ db, now }), sweepProactiveTranscript({ db, now })],
      (work) => work,
      { concurrency: 1 }
    ).pipe(
      Effect.flatMap(([, failures]) =>
        failures.length > 0 ? Effect.fail(new AgentUnavailable()) : Effect.void
      )
    ),
});
