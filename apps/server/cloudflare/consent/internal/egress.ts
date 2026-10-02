import { UserId } from "@fidy/server/identity-reference";
import { readAdmittedHostedConsent } from "../../agent/operations";
import { Effect, Option, Schema } from "effect";
import type { OnboardingConsentBasis } from "@fidy/server/consent-contract";
import type { TranscriptTurnId } from "@fidy/server/agent-contract";
import { type ConsentEgressAction, ConsentEgressRefused, ConsentUnavailable } from "../contract";
import { loadStanding } from "./standing";

const checkEgress = (
  input: Readonly<{
    db: D1Database;
    userId: string;
    admittedTurnId: Option.Option<TranscriptTurnId>;
  }>
): Effect.Effect<"allowed" | "denied", ConsentUnavailable> =>
  Effect.gen(function* () {
    const standing = yield* loadStanding(input);
    if (standing._tag === "Missing") return "denied" as const;
    if (Option.isNone(input.admittedTurnId)) {
      return standing._tag === "Granted" ? ("allowed" as const) : ("denied" as const);
    }
    const basis = yield* readAdmittedHostedConsent({
      db: input.db,
      userId: yield* Schema.decodeEffect(UserId)(input.userId),
      turnId: input.admittedTurnId.value,
    });
    return Option.exists(basis, (admitted) => matchesBasis(admitted, standing.basis))
      ? ("allowed" as const)
      : ("denied" as const);
  }).pipe(Effect.mapError(() => new ConsentUnavailable()));

const matchesBasis = (left: OnboardingConsentBasis, right: OnboardingConsentBasis): boolean =>
  left.grantId === right.grantId &&
  left.disclosureRevision === right.disclosureRevision &&
  left.disclosureSha256 === right.disclosureSha256 &&
  left.policyRevision === right.policyRevision &&
  left.policySha256 === right.policySha256;

export const performEgress = <A, E, R>(
  input: ConsentEgressAction<A, E, R>
): Effect.Effect<A, E | ConsentEgressRefused | ConsentUnavailable, R> =>
  checkEgress(input).pipe(
    Effect.flatMap((decision): Effect.Effect<A, E | ConsentEgressRefused, R> =>
      decision === "allowed" ? input.action : Effect.fail(new ConsentEgressRefused())
    )
  );
