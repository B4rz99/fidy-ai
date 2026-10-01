import { it } from "@effect/vitest";
import { Effect } from "effect";
import { expectTypeOf } from "vitest";
import type {
  AuditAuthority,
  AuditQueryCall,
  AuthorizedAuditCall,
  OwnerAuditCall,
} from "~/shell/audit/contract";

type PublicationCall<Operation extends string> = Omit<
  OwnerAuditCall,
  "caller" | "operation" | "outcome"
> &
  Readonly<{ caller: { _tag: "Publication" }; operation: Operation; outcome: "success" }>;
type CredentialCall<
  Table extends AuditAuthority["table"],
  Operation extends string,
  Outcome extends string,
> = Omit<AuthorizedAuditCall, "authority" | "operation" | "outcome"> &
  Readonly<{
    authority: AuditAuthority & { table: Table };
    operation: Operation;
    outcome: Outcome;
  }>;
type QueryCall<Operation extends string> = Omit<AuditQueryCall, "operation"> &
  Readonly<{ operation: Operation }>;

it.effect("requires credentials except for the closed supporting-publication operations", () =>
  Effect.sync(() => {
    expectTypeOf<
      PublicationCall<"transactions.createTransaction"> extends OwnerAuditCall ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      PublicationCall<"ingestion.submitForExtraction"> extends OwnerAuditCall ? true : false
    >().toEqualTypeOf<true>();
    expectTypeOf<
      CredentialCall<"pats", "unsupported.recordBody", "accepted"> extends AuthorizedAuditCall
        ? true
        : false
    >().toEqualTypeOf<false>();
  })
);

it.effect(
  "restricts outcomes and found/absent recording to supported credential-operation combinations",
  () =>
    Effect.sync(() => {
      expectTypeOf<
        CredentialCall<"web_sessions", "budgets.getBudget", "success"> extends AuthorizedAuditCall
          ? true
          : false
      >().toEqualTypeOf<false>();
      expectTypeOf<
        CredentialCall<"web_sessions", "budgets.getBudget", "accepted"> extends AuthorizedAuditCall
          ? true
          : false
      >().toEqualTypeOf<true>();
      expectTypeOf<
        CredentialCall<
          "web_sessions",
          "transactions.getTransaction",
          "success"
        > extends AuthorizedAuditCall
          ? true
          : false
      >().toEqualTypeOf<true>();
      expectTypeOf<
        CredentialCall<"pats", "transactions.getTransaction", "success"> extends AuthorizedAuditCall
          ? true
          : false
      >().toEqualTypeOf<false>();
      expectTypeOf<
        QueryCall<"budgets.getBudget"> extends AuditQueryCall ? true : false
      >().toEqualTypeOf<false>();
      expectTypeOf<
        QueryCall<"transactions.getTransaction"> extends AuditQueryCall ? true : false
      >().toEqualTypeOf<true>();
    })
);
