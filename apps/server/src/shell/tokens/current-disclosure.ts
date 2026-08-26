import { Crypto, DateTime, Effect, Encoding } from "effect";
import type { ManualPATGrantInput } from "~/core/tokens/model";
import { buildPATDisclosure, buildPairedPATDisclosure } from "~/core/tokens/rules";
import { DisclosureRevision, DisclosureSnapshot, Sha256Digest } from "~/core/consent/model";
import { currentDisclosure } from "~/shell/consent/current-disclosure";

/** Immutable revision of the Spanish manual-PAT grant disclosure template. */
export const manualPATDisclosureRevision = DisclosureRevision.make("pat-grant-2026-09");
/** Immutable revision of direct-client PAT pairing grant disclosure. */
export const pairedPATDisclosureRevision = DisclosureRevision.make("pat-pairing-grant-2026-09");

type PATDisclosureSnapshotInput = Readonly<{
  grant: ManualPATGrantInput;
  expiresAt: DateTime.Utc;
  revision: DisclosureRevision;
  buildText: (input: { grant: ManualPATGrantInput; expiresAt: DateTime.Utc }) => string;
}>;

const snapshotPATDisclosure = Effect.fn("snapshotPATDisclosure")(function* (
  input: PATDisclosureSnapshotInput
) {
  const { grant, expiresAt, revision, buildText } = input;
  const base = yield* currentDisclosure;
  const text = buildText({ grant, expiresAt });
  const digest = yield* (yield* Crypto.Crypto)
    .digest("SHA-256", new TextEncoder().encode(text))
    .pipe(Effect.orDie);
  return DisclosureSnapshot.make({
    ...base,
    revision,
    contentSha256: Sha256Digest.make(Encoding.encodeHex(digest)),
    text,
    purposes: ["Autorizar el acceso de un PAT a operaciones canónicas con alcance limitado"],
    dataCategories: ["Metadatos de seguridad, autenticación y actividad del PAT"],
    duration: `Hasta que la persona revoque el PAT o llegue su vencimiento fijo de ${grant.lifetimeDays} días: ${DateTime.formatIso(expiresAt)}.`,
    revocationMethod: "Revocar el PAT desde la administración de PATs de Fidy.",
  });
});

/** Snapshots the exact dynamic PAT disclosure and its SHA-256 digest. */
export const currentManualPATDisclosure = Effect.fn("currentManualPATDisclosure")(
  (grant: ManualPATGrantInput, expiresAt: DateTime.Utc) =>
    snapshotPATDisclosure({
      grant,
      expiresAt,
      revision: manualPATDisclosureRevision,
      buildText: buildPATDisclosure,
    })
);

/** Snapshots the exact disclosure for one direct-client paired PAT grant. */
export const currentPairedPATDisclosure = Effect.fn("currentPairedPATDisclosure")(
  (grant: ManualPATGrantInput, expiresAt: DateTime.Utc) =>
    snapshotPATDisclosure({
      grant,
      expiresAt,
      revision: pairedPATDisclosureRevision,
      buildText: buildPairedPATDisclosure,
    })
);
