import { useAtomSet } from "@effect/atom-react";
import { Option, Redacted } from "effect";
import { type FormEvent, type JSX, type RefCallback, useRef, useState } from "react";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { type DaviplataChallenge, type DaviplataConfirmation } from "./daviplata-challenge";
import {
  type EnrollmentGateway,
  type PaymentSubmission,
  type PreparedEnrollment,
} from "./enrollment-gateway";
import { BillingEmailField, EnrollmentConsent } from "./enrollment-controls";
import {
  type EnrollmentDecisions,
  allDecisionsAccepted,
  emptyDecisions,
} from "./enrollment-decisions";
import { DaviplataAuthorizationLock } from "./daviplata-activity";

type Stage =
  | "fields"
  | "sending"
  | "otp"
  | "confirming"
  | "refused"
  | "uncertain"
  | "submission-retry"
  | "retrying-submission";
type FormProps = Readonly<{
  enrollment: PreparedEnrollment;
  start: EnrollmentGateway["startDaviplata"];
  onSubmitted: (email: string, submission: PaymentSubmission) => void;
}>;
type DocumentFields = Readonly<{ documentNumber: string; productNumber: string }>;
const emptyFields: DocumentFields = { documentNumber: "", productNumber: "" };
const absentAuthorization = Option.none<never>();
const digitsOnly = (value: string): string => value.replace(/\D/gu, "");

const DocumentForm = ({
  fields,
  change,
  disabled,
}: Readonly<{
  fields: DocumentFields;
  change: (fields: DocumentFields) => void;
  disabled: boolean;
}>): JSX.Element => (
  <fieldset className="grid gap-3 sm:grid-cols-2" disabled={disabled}>
    <legend>Cédula de ciudadanía (CC). Por ahora solo admitimos CC.</legend>
    <label className="flex flex-col gap-1" htmlFor="daviplata-document">
      Número de cédula
      <Input
        id="daviplata-document"
        autoComplete="off"
        inputMode="numeric"
        pattern="[0-9]{5,15}"
        maxLength={15}
        required
        value={fields.documentNumber}
        onChange={(event) => change({ ...fields, documentNumber: digitsOnly(event.target.value) })}
      />
    </label>
    <label className="flex flex-col gap-1" htmlFor="daviplata-product">
      Número de DaviPlata
      <Input
        id="daviplata-product"
        autoComplete="off"
        inputMode="numeric"
        pattern="3[0-9]{9}"
        maxLength={10}
        required
        value={fields.productNumber}
        onChange={(event) => change({ ...fields, productNumber: digitsOnly(event.target.value) })}
      />
    </label>
  </fieldset>
);
const OtpForm = ({
  otp,
  change,
  busy,
  resend,
}: Readonly<{
  otp: string;
  change: (otp: string) => void;
  busy: boolean;
  resend: () => void;
}>): JSX.Element => (
  <>
    <label className="flex flex-col gap-1" htmlFor="daviplata-otp">
      Código de verificación
      <Input
        id="daviplata-otp"
        type="password"
        autoComplete="off"
        inputMode="numeric"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        disabled={busy}
        value={otp}
        onChange={(event) => change(digitsOnly(event.target.value))}
      />
    </label>
    <Button type="submit" disabled={busy}>
      Confirmar código
    </Button>
    <Button type="button" variant="outline" disabled={busy} onClick={resend}>
      Reenviar código
    </Button>
  </>
);
const OutcomeMessage = ({
  stage,
  retry,
}: Readonly<{ stage: Stage; retry: () => void }>): JSX.Element => (
  <>
    {stage === "refused" ? (
      <p role="alert">
        No pudimos continuar la autorización de DaviPlata. La autorización pudo vencer o alcanzar su
        límite.
      </p>
    ) : null}
    {stage === "uncertain" || stage === "submission-retry" ? (
      <p role="alert">No pudimos confirmar el resultado. No vuelvas a iniciar la autorización.</p>
    ) : null}
    {stage === "submission-retry" ? (
      <Button type="button" onClick={retry}>
        Reintentar envío de la autorización aprobada
      </Button>
    ) : null}
  </>
);

type ChallengeLifetime = Readonly<{
  lifetimeRef: RefCallback<HTMLFormElement>;
  begin: () => Option.Option<AbortSignal>;
  cancel: () => void;
  install: (challenge: DaviplataChallenge, signal: AbortSignal) => void;
  runAction: (
    action: (challenge: DaviplataChallenge) => Promise<DaviplataConfirmation>,
    apply: (outcome: DaviplataConfirmation) => void,
    failed: () => void
  ) => void;
  active: () => boolean;
}>;
const useChallengeLifetime = (unlock: () => void): ChallengeLifetime => {
  const challenge = useRef<Option.Option<DaviplataChallenge>>(absentAuthorization);
  const controller = useRef<Option.Option<AbortController>>(absentAuthorization);
  const started = useRef(false);
  const running = useRef(false);
  const mounted = useRef(false);
  const [cancel] = useState<() => void>(() => (): void => {
    Option.map(controller.current, (pending) => pending.abort());
    Option.map(challenge.current, (current) => current.dispose());
    controller.current = Option.none();
    challenge.current = Option.none();
    unlock();
  });
  const [lifetimeRef] = useState<RefCallback<HTMLFormElement>>(
    () =>
      (
        node: Parameters<RefCallback<HTMLFormElement>>[0]
      ): ReturnType<RefCallback<HTMLFormElement>> => {
        if (node === null) return;
        mounted.current = true;
        return () => {
          mounted.current = false;
          cancel();
        };
      }
  );
  return {
    lifetimeRef,
    cancel,
    runAction: (action, apply, failed) => {
      if (running.current || !mounted.current) return;
      running.current = true;
      Option.map(challenge.current, (live) =>
        action(live)
          .then(apply, failed)
          .finally(() => {
            running.current = false;
          })
      );
    },
    active: () =>
      mounted.current && Option.exists(controller.current, (pending) => !pending.signal.aborted),
    begin: () => {
      if (started.current || !mounted.current) return Option.none();
      started.current = true;
      const pending = new AbortController();
      controller.current = Option.some(pending);
      return Option.some(pending.signal);
    },
    install: (current, signal) => {
      if (signal.aborted) current.dispose();
      else challenge.current = Option.some(current);
    },
  };
};
type Draft = Readonly<{
  stage: Stage;
  setStage: (stage: Stage) => void;
  fields: DocumentFields;
  setFields: (fields: DocumentFields) => void;
  email: string;
  setEmail: (email: string) => void;
  otp: string;
  setOtp: (otp: string) => void;
  decisions: EnrollmentDecisions;
  setDecisions: (decisions: EnrollmentDecisions) => void;
}>;
const useDraft = (emailValue: string): Draft => {
  const [stage, setStage] = useState<Stage>("fields");
  const [fields, setFields] = useState(emptyFields);
  const [email, setEmail] = useState(emailValue);
  const [otp, setOtp] = useState("");
  const [decisions, setDecisions] = useState(emptyDecisions);
  return {
    stage,
    setStage,
    fields,
    setFields,
    email,
    setEmail,
    otp,
    setOtp,
    decisions,
    setDecisions,
  };
};
const beginAuthorization = (
  props: FormProps,
  draft: Draft,
  control: Readonly<{ lifetime: ChallengeLifetime; lock: (locked: boolean) => void }>
): void => {
  if (!allDecisionsAccepted(draft.decisions)) return;
  const started = control.lifetime.begin();
  if (Option.isNone(started)) return;
  const signal = started.value;
  const setStage = draft.setStage;
  control.lock(true);
  draft.setStage("sending");
  draft.setFields(emptyFields);
  props
    .start(props.enrollment, draft.email.trim().toLowerCase(), {
      documentNumber: Redacted.make(draft.fields.documentNumber),
      productNumber: Redacted.make(draft.fields.productNumber),
      signal,
    })
    .then(
      (challenge) => {
        control.lifetime.install(challenge, signal);
        if (!signal.aborted) setStage("otp");
      },
      () => {
        if (!signal.aborted) setStage("uncertain");
      }
    );
};
type Commands = Readonly<{
  lifetimeRef: RefCallback<HTMLFormElement>;
  submit: (event: FormEvent) => void;
  resend: () => void;
  retry: () => void;
  cancel: () => void;
}>;
const useDaviplataInteraction = (props: FormProps): Draft & Commands => {
  const draft = useDraft(props.enrollment.billingEmail);
  const lock = useAtomSet(DaviplataAuthorizationLock.use());
  const lifetime = useChallengeLifetime(() => lock(false));
  const { setStage, email } = draft;
  const apply = (outcome: DaviplataConfirmation): void => {
    if (!lifetime.active()) return;
    if (outcome.status === "submitted") {
      props.onSubmitted(email.trim().toLowerCase(), outcome.submission);
      return;
    }
    if (outcome.status === "retry-allowed") {
      setStage("otp");
      return;
    }
    if (outcome.status === "refused") {
      lifetime.cancel();
      setStage("refused");
      return;
    }
    setStage(outcome.retrySubmission ? "submission-retry" : "uncertain");
  };
  const run = (
    action: (challenge: DaviplataChallenge) => Promise<DaviplataConfirmation>,
    pendingStage: Stage = "confirming"
  ): void => {
    if (draft.stage !== "otp" && draft.stage !== "submission-retry") return;
    setStage(pendingStage);
    draft.setOtp("");
    lifetime.runAction(action, apply, () => {
      if (lifetime.active()) setStage("uncertain");
    });
  };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (draft.stage === "fields") beginAuthorization(props, draft, { lifetime, lock });
    else if (draft.stage === "otp") run((challenge) => challenge.confirm(Redacted.make(draft.otp)));
  };
  return {
    ...draft,
    lifetimeRef: lifetime.lifetimeRef,
    submit,
    resend: () => {
      if (draft.stage === "otp") run((challenge) => challenge.resend());
    },
    retry: () => {
      if (draft.stage === "submission-retry") {
        run((challenge) => challenge.retrySubmission(), "retrying-submission");
      }
    },
    cancel: () => {
      lifetime.cancel();
      draft.setOtp("");
      draft.setFields(emptyFields);
      setStage("refused");
    },
  };
};

const authorizationBusy = (stage: Stage): boolean =>
  stage === "sending" || stage === "confirming" || stage === "retrying-submission";
const awaitingOtp = (stage: Stage): boolean => stage === "otp" || stage === "confirming";
const cancellableStage = (stage: Stage): boolean => stage === "sending" || awaitingOtp(stage);
const AuthorizationProgress = ({ stage }: Readonly<{ stage: Stage }>): JSX.Element => (
  <>
    {stage === "sending" ? <output>Solicitando código a Wompi…</output> : null}
    {stage === "retrying-submission" ? (
      <output>Enviando la autorización ya aprobada…</output>
    ) : null}
  </>
);

/** Event-driven mounted form. Sensitive drafts and the live challenge remain local until disposal. */
export const DaviplataEnrollmentForm = (props: FormProps): JSX.Element => {
  const interaction = useDaviplataInteraction(props);
  const [mountForm] = useState<RefCallback<HTMLFormElement>>(
    () =>
      (
        node: Parameters<RefCallback<HTMLFormElement>>[0]
      ): ReturnType<RefCallback<HTMLFormElement>> =>
        interaction.lifetimeRef(node)
  );
  const { stage } = interaction;
  const busy = authorizationBusy(stage);
  return (
    <form ref={mountForm} className="flex flex-col gap-5" onSubmit={interaction.submit}>
      {stage === "fields" ? (
        <>
          <DocumentForm
            fields={interaction.fields}
            change={interaction.setFields}
            disabled={busy}
          />
          <BillingEmailField
            email={interaction.email}
            disabled={busy}
            setEmail={interaction.setEmail}
          />
          <EnrollmentConsent
            enrollment={props.enrollment}
            disabled={busy}
            decisions={interaction.decisions}
            setDecisions={interaction.setDecisions}
          />
          <Button disabled={busy || !allDecisionsAccepted(interaction.decisions)} type="submit">
            Autorizar con DaviPlata
          </Button>
        </>
      ) : null}
      {awaitingOtp(stage) ? (
        <OtpForm
          otp={interaction.otp}
          change={interaction.setOtp}
          busy={busy}
          resend={interaction.resend}
        />
      ) : null}
      <AuthorizationProgress stage={stage} />
      {cancellableStage(stage) ? (
        <Button type="button" variant="outline" onClick={interaction.cancel}>
          Cancelar autorización
        </Button>
      ) : null}
      <OutcomeMessage stage={stage} retry={interaction.retry} />
      <p className="text-sm text-muted-foreground">
        No cierres ni recargues esta página: el código y la autorización no pueden recuperarse al
        volver. Fidy nunca conserva tu documento, número de DaviPlata ni código.
      </p>
    </form>
  );
};
