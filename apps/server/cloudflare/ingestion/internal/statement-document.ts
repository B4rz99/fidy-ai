import { Digest } from "effect/crypto";
import { readWhatsAppStatementMedia } from "../../../src/shell/ingestion/operations";
import { Effect } from "effect";

const workerDigest = Effect.runSync(Digest.Digest.pipe(Effect.provide(Digest.layerWebCrypto)));

export const retrieveHeldStatementMedia = (
  work: Parameters<typeof readWhatsAppStatementMedia>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof readWhatsAppStatementMedia>>,
  Effect.Error<ReturnType<typeof readWhatsAppStatementMedia>>
> => readWhatsAppStatementMedia(work).pipe(Effect.provideService(Digest.Digest, workerDigest));
