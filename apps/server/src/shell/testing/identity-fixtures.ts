import { Crypto, Effect, Option } from "effect";
import { EmailAddress } from "~/core/email-authentication/model";
import type { User } from "~/core/identity/model";
import {
  type UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "~/core/identity/reference";
import { TokenBearer } from "~/core/tokens/model";
import { hasCurrentOnboardingConsent } from "~/shell/consent/repo";
import { seedOnboardingConsent } from "~/shell/db/development-seed";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { installVerifiedEmailCredentialInScope } from "~/shell/email-authentication/repo";
import { associateWhatsAppIdentity, upsertDevelopmentUser } from "~/shell/identity/repo";
import { upsertDevelopmentBackupRecoveryCredentialInScope } from "~/shell/recovery/repo";

/** Creates the complete stable-state invariant for tests that need an existing User. */
export const upsertStableUserFixture = Effect.fn("Testing.upsertStableUserFixture")(function* (
  userId: UserId,
  user: User
) {
  yield* withUserTransaction(
    userId,
    Effect.gen(function* () {
      yield* upsertDevelopmentUser(userId, user);
      if (!(yield* hasCurrentOnboardingConsent(userId))) yield* seedOnboardingConsent(userId);
      const compactUserId = userId.replaceAll("-", "");
      yield* associateWhatsAppIdentity(userId, {
        businessPortfolioId: WhatsAppBusinessPortfolioId.make("fidy-test"),
        businessScopedUserId: WhatsAppBusinessScopedUserId.make(`CO.${compactUserId}`),
        parentBusinessScopedUserId: Option.none(),
        username: Option.none(),
        phoneNumber: Option.none(),
        verifiedAt: user.createdAt,
      });
      const crypto = yield* Crypto.Crypto;
      const recoveryDigest = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(`test-recovery:${userId}`))
        .pipe(Effect.orDie);
      yield* installVerifiedEmailCredentialInScope({
        userId,
        email: EmailAddress.make(`test-${userId}@example.com`),
        verifiedAt: user.createdAt,
      });
      yield* upsertDevelopmentBackupRecoveryCredentialInScope({
        userId,
        codeDigest: recoveryDigest,
        createdAt: user.createdAt,
      });
    })
  );
});

/** The deterministic all-scopes bearer used only by API-seam tests. */
export const defaultPatBearer = TokenBearer.make(
  "fin_default1_0123456789abcdefghijklmnopqrstuvwxyzABCD"
);
