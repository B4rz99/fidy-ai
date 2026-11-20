import { offerChannel } from "./internal/local-channel-delivery";
import { hostedDocument, hostedText } from "./internal/local-whatsapp";
import { inspectTurns, recoverTurns } from "./internal/local-recovery";
import { browserHosted, browserHostedPaths } from "./internal/local-hosted";
import { projections as erasureProjections } from "./internal/erasure";
import { makeErasureStore } from "../erasure-store/runtime";
import type { ErasureStore } from "../erasure-store/contract";
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

export const makeAgentService = (input: AgentServiceInput): AgentService => {
  const service = makeHostedService(input);
  return {
    accept: (request) => service.accept(request),
    recover: () =>
      service.recover().catch(() => {
        throw new AgentUnavailable();
      }),
  };
};

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

export const makeAgentErasureStores = (db: D1Database): ReadonlyArray<ErasureStore> =>
  erasureProjections.map((projection) => makeErasureStore({ db, projection }));

export const isLocalHostedPath = (path: string): boolean => browserHostedPaths.includes(path);
export const handleLocalHosted: typeof browserHosted = (...args) => browserHosted(...args);

export const repairLocalHostedAlarm: typeof inspectTurns = (...args) => inspectTurns(...args);
export const recoverLocalHosted: typeof recoverTurns = (...args) => recoverTurns(...args);

export const admitLocalHostedDocument: typeof hostedDocument = (...args) => hostedDocument(...args);
export const acceptLocalHostedText: typeof hostedText = (...args) => hostedText(...args);

export const offerLocalHostedReply: typeof offerChannel = (...args) => offerChannel(...args);
