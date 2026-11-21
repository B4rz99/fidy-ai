import { Digest } from "effect/crypto";
import { readWhatsAppStatementMedia } from "../../../src/shell/ingestion/operations";
import { Effect, ManagedRuntime } from "effect";

const digestRuntime = ManagedRuntime.make(Digest.layerWebCrypto);

const workerDigest = digestRuntime.runSync(Digest.Digest);

export const retrieveHeldStatementMedia = (
  work: Parameters<typeof readWhatsAppStatementMedia>[0]
): Effect.Effect<
  Effect.Success<ReturnType<typeof readWhatsAppStatementMedia>>,
  Effect.Error<ReturnType<typeof readWhatsAppStatementMedia>>
> => readWhatsAppStatementMedia(work).pipe(Effect.provideService(Digest.Digest, workerDigest));
