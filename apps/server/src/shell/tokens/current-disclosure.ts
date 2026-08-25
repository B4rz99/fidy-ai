import { Crypto, DateTime, Effect, Encoding } from "effect";
import type { ManualPATGrantInput } from "~/core/tokens/model";
import { buildPATDisclosure } from "~/core/tokens/rules";
import { DisclosureRevision, DisclosureSnapshot, Sha256Digest } from "~/core/consent/model";
import { currentDisclosure } from "~/shell/consent/current-disclosure";

/** Immutable revision of the Spanish manual-PAT grant disclosure template. */
export const manualPATDisclosureRevision = DisclosureRevision.make("pat-grant-2026-09");

/** Snapshots the exact dynamic PAT disclosure and its SHA-256 digest. */
export const currentManualPATDisclosure = Effect.fn("currentManualPATDisclosure")(function* (
  grant: ManualPATGrantInput,
  expiresAt: DateTime.Utc
) {
  const base = yield* currentDisclosure;
  const text = buildPATDisclosure({ grant, expiresAt });
  const digest = yield* (yield* Crypto.Crypto)
    .digest("SHA-256", new TextEncoder().encode(text))
    .pipe(Effect.orDie);
  return DisclosureSnapshot.make({
    ...base,
    revision: manualPATDisclosureRevision,
    contentSha256: Sha256Digest.make(Encoding.encodeHex(digest)),
    text,
    purposes: ["Autorizar el acceso de un PAT a operaciones canónicas con alcance limitado"],
    dataCategories: ["Metadatos de seguridad, autenticación y actividad del PAT"],
    duration: `Hasta que la persona revoque el PAT o llegue su vencimiento fijo de ${grant.lifetimeDays} días: ${DateTime.formatIso(expiresAt)}.`,
    revocationMethod: "Revocar el PAT desde la administración de PATs de Fidy.",
  });
});
