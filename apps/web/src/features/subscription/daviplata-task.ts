import { Option, Redacted } from "effect";
import { type DaviplataChallenge, type DaviplataConfirmation } from "./daviplata-challenge";
import {
  DaviplataSetupFailed,
  type EnrollmentGateway,
  type PaymentSubmission,
  type PreparedEnrollment,
} from "./enrollment-gateway";
import { type EnrollmentDecisions, allDecisionsAccepted } from "./enrollment-decisions";

export type DaviplataStage =
  | "fields"
  | "sending"
  | "otp"
  | "confirming"
  | "refused"
  | "uncertain"
  | "submission-retry"
  | "retrying-submission";
type TaskInput = Readonly<{
  enrollment: PreparedEnrollment;
  start: EnrollmentGateway["startDaviplata"];
  publish: (stage: DaviplataStage) => void;
  lock: (locked: boolean) => void;
  onSubmitted: (email: string, submission: PaymentSubmission) => void;
  onUncertain: () => void;
}>;
type BeginInput = Readonly<{
  email: string;
  decisions: EnrollmentDecisions;
  documentNumber: Redacted.Redacted<string>;
  productNumber: Redacted.Redacted<string>;
}>;
type MountedDaviplata = Readonly<{
  mount: () => () => void;
  begin: (fields: BeginInput) => void;
  confirm: (otp: Redacted.Redacted<string>) => void;
  resend: () => void;
  retry: () => void;
  cancel: () => boolean;
}>;
type Task = Readonly<{
  input: TaskInput;
  controller: AbortController;
  state: {
    phase: DaviplataStage | "disposed";
    mounted: boolean;
    email: string;
    challenge: Option.Option<DaviplataChallenge>;
  };
}>;
const active = (task: Task): boolean => task.state.mounted && !task.controller.signal.aborted;
const change = (task: Task, next: DaviplataStage): void => {
  task.state.phase = next;
  task.input.lock(next !== "fields" && next !== "refused");
  if (task.state.mounted) task.input.publish(next);
};
const retire = (task: Task): void => {
  task.controller.abort();
  Option.map(task.state.challenge, (current) => current.dispose());
  task.state.challenge = Option.none();
  task.state.email = "";
};
const uncertain = (task: Task, retry: boolean): void => {
  if (!retry) retire(task);
  change(task, retry ? "submission-retry" : "uncertain");
  task.input.onUncertain();
};
const apply = (task: Task, outcome: DaviplataConfirmation): void => {
  if (!active(task) || outcome.status === "busy") return;
  if (outcome.status === "submitted") {
    task.input.onSubmitted(task.state.email, outcome.submission);
    retire(task);
    return;
  }
  if (outcome.status === "retry-allowed") change(task, "otp");
  else if (outcome.status === "refused") {
    retire(task);
    change(task, "refused");
  } else uncertain(task, outcome.retrySubmission);
};
const run = (
  task: Task,
  required: "otp" | "submission-retry",
  action: (current: DaviplataChallenge) => Promise<DaviplataConfirmation>
): boolean => {
  if (!active(task) || task.state.phase !== required || Option.isNone(task.state.challenge)) {
    return false;
  }
  const current = task.state.challenge.value;
  change(task, required === "otp" ? "confirming" : "retrying-submission");
  action(current).then(
    (outcome) => apply(task, outcome),
    () => {
      if (active(task)) uncertain(task, false);
    }
  );
  return true;
};
const begin = (task: Task, fields: BeginInput): void => {
  if (!active(task) || task.state.phase !== "fields" || !allDecisionsAccepted(fields.decisions)) {
    Redacted.wipeUnsafe(fields.documentNumber);
    Redacted.wipeUnsafe(fields.productNumber);
    return;
  }
  task.state.email = fields.email.trim().toLowerCase();
  change(task, "sending");
  task.input
    .start(task.input.enrollment, task.state.email, {
      documentNumber: fields.documentNumber,
      productNumber: fields.productNumber,
      signal: task.controller.signal,
    })
    .then(
      (current) => {
        if (!active(task)) current.dispose();
        else {
          task.state.challenge = Option.some(current);
          change(task, "otp");
        }
      },
      (error: unknown) => {
        if (!active(task)) return;
        if (error instanceof DaviplataSetupFailed && error.status === "refused") {
          retire(task);
          change(task, "refused");
        } else uncertain(task, false);
      }
    );
};
export const makeMountedDaviplata = (input: TaskInput): MountedDaviplata => {
  const task: Task = {
    input,
    controller: new AbortController(),
    state: { phase: "fields", mounted: false, email: "", challenge: Option.none() },
  };
  return {
    mount: () => {
      task.state.mounted = true;
      return () => {
        task.state.mounted = false;
        if (task.state.phase !== "fields") {
          task.state.phase = "disposed";
          retire(task);
        }
        input.lock(false);
      };
    },
    begin: (fields) => begin(task, fields),
    confirm: (otp) => {
      if (!run(task, "otp", (current) => current.confirm(otp))) {
        Redacted.wipeUnsafe(otp);
      }
    },
    resend: () => {
      run(task, "otp", (current) => current.resend());
    },
    retry: () => {
      run(task, "submission-retry", (current) => current.retrySubmission());
    },
    cancel: () => {
      if (
        !active(task) ||
        task.state.phase === "fields" ||
        task.state.phase === "refused" ||
        task.state.phase === "uncertain"
      ) {
        return false;
      }
      retire(task);
      change(task, "refused");
      return true;
    },
  };
};
