import type { RecoveryLifecycleEnvironment } from "../contract";
import { native } from "./context";

type Outcome<A> =
  | Readonly<{ kind: "completed"; value: A }>
  | Readonly<{ kind: "refused"; failure: Error }>;

// This classifier is private to direct native D1 calls. Public Errors, owner errors, and
// remote Store decoders cannot supply this provenance. Native D1 currently exposes its
// acknowledged SQLite rollback only through the exact Error/cause acknowledgement pair.
const closedRefusal = (failure: unknown): failure is Error => {
  if (!(failure instanceof Error) || !(failure.cause instanceof Error)) return false;
  const native = failure.cause.message;
  if (failure.message !== `D1_ERROR: ${native}`) return false;
  return (
    /^(resource_admission_refused|canonical_request_rate|canonical_request_concurrency|commercial_quota_exhausted|commercial_authority_required|recurring_cursor_changed|media_publication_required|media_work_capacity|connection_browser_commit|forwarded_email_deferred_capacity): SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_TRIGGER\)$/u.test(
      native
    ) ||
    /^CHECK constraint failed: canonical_child_(guard|capacity)_(0|[1-9]|10|11): SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_CHECK\)$/u.test(
      native
    )
  );
};

/** A known native rollback settles transport; the owner still receives its original refusal. */
export const sql = <A>({
  environment,
  work,
}: Readonly<{
  environment: RecoveryLifecycleEnvironment;
  work: () => Promise<A>;
}>): Promise<A> =>
  native({
    environment,
    work: (): Promise<Outcome<A>> =>
      work().then(
        (value) => ({ kind: "completed", value }),
        (failure: unknown) =>
          closedRefusal(failure) ? { kind: "refused", failure } : Promise.reject(failure)
      ),
  }).then((outcome) =>
    outcome.kind === "completed" ? outcome.value : Promise.reject(outcome.failure)
  );
