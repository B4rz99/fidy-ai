import { Effect } from "effect";
import { WhatsAppUnavailable } from "./contract";
import {
  dispatchWhatsAppWork as dispatch,
  receiveWhatsAppWork as receive,
} from "./internal/historical-whatsapp-work.test-fixture";
/** Offer only bounded User/Turn identities; the transactional outbox survives missed publication. */
export const dispatchWhatsAppWork = (
  input: Parameters<typeof dispatch>[0]
): Effect.Effect<void, WhatsAppUnavailable> =>
  dispatch(input).pipe(Effect.mapError(() => new WhatsAppUnavailable()));
/** Decode and dispatch each identity-only message to its same User coordinator; redelivery cannot duplicate a send. */
export const receiveWhatsAppWork = (input: Parameters<typeof receive>[0]): Promise<void> =>
  Effect.runPromise(receive(input).pipe(Effect.mapError(() => new WhatsAppUnavailable())));
