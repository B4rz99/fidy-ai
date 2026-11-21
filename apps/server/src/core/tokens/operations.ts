import { DateTime, Duration, Effect, Option } from "effect";
import {
  type ManualPATGrantInput,
  type PATLifetimeDays,
  type PATPairingClaimDecision,
  type PATPairingClaimInput,
  type PATPairingLifecycle,
  type PATScopes,
  TokenBearer,
  type TokenSecret,
  TokenShortId,
  patBearerPrefix,
  patPairingLifetime,
  patShortIdLength,
} from "./contract";

const publicCodeAlphabet = "BCDFGHJKLMNPQRSTVWXZ";
const unbiasedBase20ByteLimit = 240;

export const computePATExpiration = ({
  createdAt,
  lifetimeDays,
}: Readonly<{
  createdAt: DateTime.Utc;
  lifetimeDays: PATLifetimeDays;
}>): Effect.Effect<DateTime.Utc, never, never> =>
  Effect.succeed(DateTime.addDuration(createdAt, Duration.days(lifetimeDays)));

export const patScopeCopy: Record<
  PATScopes[number],
  Readonly<{ label: string; description: string }>
> = {
  read: {
    label: "Lectura",
    description: "Consultar tus datos financieros en Fidy.",
  },
  write: {
    label: "Escritura",
    description: "Crear y modificar tus datos financieros en Fidy.",
  },
  dashboard: {
    label: "Tablero",
    description: "Consultar y modificar tu tablero financiero en Fidy.",
  },
};

const hoursPerDay = 24;
type GrantDetails = Pick<ManualPATGrantInput, "recipientLabel" | "scopes" | "lifetimeDays">;

const disclosureFor = (
  { recipientLabel, scopes, lifetimeDays }: GrantDetails,
  expiresAt: DateTime.Utc,
  delivery: string
): string => `Nombre: “${recipientLabel}”.

Alcances autorizados:
${scopes.map((scope) => `- ${patScopeCopy[scope].label}: ${patScopeCopy[scope].description}`).join("\n")}

Duración fija: ${lifetimeDays} días (${lifetimeDays * hoursPerDay} horas). Vencimiento exacto: ${DateTime.formatIso(expiresAt)}. El vencimiento no se extiende con el uso. Para obtener una fecha posterior debes crear un PAT de reemplazo. Puedes revocarlo antes desde la administración de PATs.

${delivery} Después conservará únicamente su resumen criptográfico; no podrá recuperar el valor original.`;

export const buildPATDisclosure = ({
  grant,
  expiresAt,
}: Readonly<{ grant: ManualPATGrantInput; expiresAt: DateTime.Utc }>): string =>
  disclosureFor(grant, expiresAt, "Fidy mostrará el PAT completo una sola vez en esta respuesta.");

export const buildPairedPATDisclosure = ({
  grant,
  expiresAt,
}: Readonly<{ grant: GrantDetails; expiresAt: DateTime.Utc }>): string =>
  disclosureFor(
    grant,
    expiresAt,
    "Fidy entregará el PAT completo una sola vez directamente al cliente que inició esta vinculación; este navegador no lo recibirá."
  );

type TokenBearerSegments = Readonly<{
  shortId: Readonly<TokenShortId>;
  secret: Readonly<TokenSecret>;
}>;

export const makeTokenBearer = ({
  shortId,
  secret,
}: TokenBearerSegments): Effect.Effect<TokenBearer> =>
  Effect.succeed(TokenBearer.make(`${patBearerPrefix}${String(shortId)}_${String(secret)}`));

export const getTokenShortId = (bearer: Readonly<TokenBearer>): Effect.Effect<TokenShortId> =>
  Effect.succeed(
    TokenShortId.make(
      bearer.slice(patBearerPrefix.length, patBearerPrefix.length + patShortIdLength)
    )
  );

export const selectPATPairingPublicCodeSymbols = (input: {
  readonly bytes: ReadonlyArray<number>;
  readonly maximum: number;
}): string =>
  input.bytes
    .filter((byte) => byte < unbiasedBase20ByteLimit)
    .slice(0, input.maximum)
    .map((byte) => publicCodeAlphabet[byte % publicCodeAlphabet.length])
    .join("");

export const patPairingExpiry = (createdAt: DateTime.Utc): DateTime.Utc =>
  DateTime.addDuration(createdAt, patPairingLifetime);

const millisecondsPerSecond = 1_000;
const pollingSlowdownIncrementSeconds = 5;
const maximumWrongProofAttempts = 32_767;
export const pairingWrongProofLimit = 5;

const isActivePairing = (lifecycle: PATPairingLifecycle): boolean =>
  lifecycle === "pending_approval" || lifecycle === "approved_awaiting_claim";
const expiryDecision = (lifecycle: PATPairingLifecycle): PATPairingClaimDecision =>
  lifecycle === "pending_approval" ? { _tag: "ExpireUnapproved" } : { _tag: "RevokeUnclaimed" };

const decidePATPairingClaimValue = (input: PATPairingClaimInput): PATPairingClaimDecision => {
  if (!isActivePairing(input.lifecycle)) return { _tag: "Invalid" };
  if (DateTime.isGreaterThanOrEqualTo(input.attemptedAt, input.expiresAt)) {
    return expiryDecision(input.lifecycle);
  }
  if (!input.proofMatches) {
    return {
      _tag: "WrongProof",
      wrongProofAttempts: Math.min(maximumWrongProofAttempts, input.wrongProofAttempts + 1),
    };
  }
  if (Option.isSome(input.lastAcceptedPollAt)) {
    const elapsedSeconds =
      (DateTime.toEpochMillis(input.attemptedAt) -
        DateTime.toEpochMillis(input.lastAcceptedPollAt.value)) /
      millisecondsPerSecond;
    if (elapsedSeconds < input.minimumPollIntervalSeconds) {
      const minimumPollIntervalSeconds =
        input.minimumPollIntervalSeconds + pollingSlowdownIncrementSeconds;
      return {
        _tag: "SlowDown",
        minimumPollIntervalSeconds,
        retryAfterSeconds: Math.max(1, Math.ceil(minimumPollIntervalSeconds - elapsedSeconds)),
      };
    }
  }
  return input.lifecycle === "approved_awaiting_claim"
    ? { _tag: "Claim" }
    : {
        _tag: "Pending",
        acceptedAt: input.attemptedAt,
        minimumPollIntervalSeconds: input.minimumPollIntervalSeconds,
      };
};

export const decidePATPairingClaim = (
  input: PATPairingClaimInput
): Effect.Effect<PATPairingClaimDecision> => Effect.succeed(decidePATPairingClaimValue(input));
