import type { HostedCanonicalCaller } from "../canonical-work/contract";
import type { PATActivityAuthority } from "../../src/shell/audit/contract";
import type { PATSubject } from "../../src/shell/tokens/contract";
import type { WebSessionSubject } from "../../src/shell/web-session/contract";
import { Data } from "effect";

export class PATUnavailable extends Data.TaggedError("PATUnavailable") {}

export type PATAuthorizationDecision =
  | "accepted"
  | "unauthenticated"
  | "scope_missing"
  | "user_action_required";

export type AuthorizedPAT = PATSubject;

export type PATRequest = Readonly<{ request: Request; db: D1Database }>;

export type PATMetadataQuery = Readonly<{
  db: D1Database;
  subject: WebSessionSubject | AuthorizedPAT | HostedCanonicalCaller;
}>;

export type PATActivityRead = Readonly<{
  db: D1Database;
  userId: string;
  shortId: string;
  current: number;
  authority: PATActivityAuthority;
}>;

export const nativePATDirectoryUrl = "https://directory.invalid/credentials/pat";

export const localPATClaimUrl = "https://user.invalid/credentials/pat-claim";
