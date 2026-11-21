import type { OpenAiEnvironment } from "../../ai/contract";
import { preflightRefusal, validateAdmission } from "./local-inference";
import { Clock, Effect, Option, Schema } from "effect";
import {
  HostedTurnProgressRequest,
  HostedTurnReceipt,
  HostedTurnRequest,
} from "../../../src/shell/agent/contract";
import { type TranscriptText, type TranscriptTurnId } from "../../../src/core/agent/contract";
import { RequestBodyPolicy } from "../../http/contract";
import { boundedJsonBody } from "../../http/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import {
  beginTurn,
  channelReply,
  channelStatus,
  observeTurn,
  turnProof,
  unavailable,
} from "./local-turn-store";

const turnBody = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16384,
  deadlineMilliseconds: 2000,
});

const progressBody = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 512,
  deadlineMilliseconds: 2000,
});

type Command =
  | { text: TranscriptText }
  | { turnId: TranscriptTurnId }
  | { turnId: TranscriptTurnId; receipt: string };

export const browserHostedPaths = [
  "/web/hosted-turns",
  "/web/hosted-turns/progress",
  "/web/hosted-turns/delivery",
];

const commandFor = (request: Request, path: string): Effect.Effect<Option.Option<Command>> => {
  if (path === browserHostedPaths[0]) {
    return boundedJsonBody({ request, policy: turnBody, schema: HostedTurnRequest });
  }

  if (path === browserHostedPaths[1]) {
    return boundedJsonBody({ request, policy: progressBody, schema: HostedTurnProgressRequest });
  }

  return boundedJsonBody({ request, policy: progressBody, schema: HostedTurnReceipt });
};

export const browserHosted = Effect.fn(
  function* (
    request: Request,
    owns: (id: string) => boolean,
    { storage, env }: { storage: DurableObjectStorage; env: OpenAiEnvironment }
  ) {
    const resolve = yield* turnProof(request, owns);
    const command = yield* commandFor(request, new URL(request.url).pathname);

    return yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const actor = yield* resolve(now);

      if (Option.isNone(actor)) {
        return channelReply(channelStatus.unauthenticated)({ status: "unauthenticated" });
      }

      if (Option.isNone(command)) {
        return channelReply(channelStatus.invalid)({ status: "validation_failed" });
      }

      if ("text" in command.value) {
        return yield* validateAdmission(
          env,
          yield* beginTurn(
            { userId: actor.value.userId, id: Option.some(actor.value.id) },
            command.value.text,
            storage
          )
        );
      }

      return yield* observeTurn(actor.value, command.value, now);
    }).pipe(
      withStoreCapacity(Option.isSome(command) && "text" in command.value ? "growth" : "required")
    );
  },
  Effect.catchTag("HostedInferenceError", (err) => Effect.succeed(preflightRefusal(err))),
  Effect.tapCause(() =>
    Effect.logWarning({ component: "agent", operation: "browserHosted", outcome: "unavailable" })
  ),
  Effect.catchCause(() => Effect.succeed(unavailable()))
);
