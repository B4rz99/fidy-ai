import { DateTime, Effect, Layer, Option } from "effect";
import { AgentService } from "~/shell/agent/agent-service";
import { sendKapsoFreeForm } from "./outbound";
import {
  claimWhatsAppTurn,
  completeWhatsAppTurn,
  failWhatsAppTurn,
  pruneWhatsAppOperationalData,
  startWhatsAppTurn,
} from "./repo";

/** Processes one due User burst, returning false only when no work is due; failures become terminal evidence. */
export const processNextWhatsAppTurn = Effect.fn("WhatsApp.processNextTurn")(function* (
  claimTime: DateTime.Utc
) {
  const claimed = yield* claimWhatsAppTurn(claimTime);
  if (Option.isNone(claimed)) return false;
  const claim = claimed.value;
  if (claim.action === "retire_ambiguous") {
    yield* failWhatsAppTurn(claim, claimTime, "ambiguous_crash");
    return true;
  }

  const started = yield* Effect.option(startWhatsAppTurn(claim));
  if (Option.isNone(started)) {
    yield* failWhatsAppTurn(claim, claimTime, "ambiguous_crash");
    return true;
  }

  const service = yield* AgentService;
  const prepared = yield* Effect.option(
    service.handleTurn(claim.userId, started.value.inboundMessage)
  );
  if (Option.isNone(prepared)) {
    yield* failWhatsAppTurn(claim, claimTime, "agent_failed");
    return true;
  }

  const sent = yield* Effect.option(
    sendKapsoFreeForm(claim.userId, prepared.value.reply, yield* DateTime.now)
  );
  if (Option.isNone(sent)) {
    yield* failWhatsAppTurn(claim, claimTime, "send_failed");
    return true;
  }

  yield* service.recordDeliveredReply(prepared.value);
  yield* completeWhatsAppTurn(claim, claimTime);
  return true;
});

const workerLoop = Effect.forever(
  Effect.gen(function* () {
    const processed = yield* processNextWhatsAppTurn(yield* DateTime.now);
    if (!processed) yield* Effect.sleep("250 millis");
  })
);
const retentionLoop = Effect.forever(
  Effect.gen(function* () {
    yield* pruneWhatsAppOperationalData();
    yield* Effect.sleep("1 hour");
  })
);

/** Runs the durable WhatsApp turn processor for the lifetime of the application scope. */
export const WhatsAppWorkerLive = Layer.effectDiscard(
  Effect.forkScoped(
    Effect.all([...Array.from({ length: 8 }, () => workerLoop), retentionLoop], {
      concurrency: "unbounded",
      discard: true,
    })
  )
);
