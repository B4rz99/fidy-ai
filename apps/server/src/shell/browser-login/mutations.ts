import { Effect } from "effect";
import type { UserId } from "~/core/identity/reference";
import type { CanonicalMutationImplementation } from "~/shell/_shared/canonical-mutation";
import type {
  BrowserLoginPairingApproval,
  BrowserLoginPairingApprovalRateLimited,
  BrowserLoginPairingApprovalRejected,
} from "./operations";
import { approveBrowserLoginPairingInScope } from "./repo";

export type ApproveBrowserLoginPairingInput = Readonly<{
  userId: UserId;
  publicCode: string;
}>;

type ApprovalResponse = Readonly<{
  data: typeof BrowserLoginPairingApproval.Type;
  next: readonly [];
}>;

/** Binds one unbound challenge using only authority resolved by the hosted canonical boundary. */
export const approveBrowserLoginPairing: CanonicalMutationImplementation<
  ApproveBrowserLoginPairingInput,
  ApprovalResponse,
  BrowserLoginPairingApprovalRejected | BrowserLoginPairingApprovalRateLimited
> = Effect.fn("approveBrowserLoginPairing")(function* ({ userId, publicCode }) {
  const approval = yield* approveBrowserLoginPairingInScope({ userId, publicCode });
  return { data: approval, next: [] };
});
