import {
  type IssuedPAT,
  PATScope,
  countPATLabelCharacters,
  patLifetimeDayOptions,
  patScopeCopy,
  recipientLabelLimit,
} from "@/transport/client";
import { DateTime, Option, Redacted } from "effect";
import { type FormEvent, type JSX, type RefCallback, useState } from "react";
import type { PATCreationActions, PATCreationDisplay, ReviewedManualPATGrant } from "./issuance";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { Checkbox } from "@/ui/components/checkbox";
import { Label } from "@/ui/components/label";
import { Input } from "@/ui/components/input";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";

const lifetimeOptions = patLifetimeDayOptions.map((lifetimeDays) => ({
  lifetimeDays,
  value: String(lifetimeDays),
  label: `${lifetimeDays} días`,
}));

const patExpirationFormatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Bogota",
});

const scopeDescriptions = {
  read: "Consultar tus datos financieros.",
  write: "Crear y modificar tus datos financieros.",
  dashboard: "Consultar y modificar tu tablero financiero.",
} as const;

const scopeOptions = (["read", "write", "dashboard"] as const).map((scope) => ({
  scope: PATScope.make(scope),
  ...patScopeCopy[scope],
  description: scopeDescriptions[scope],
}));

const toggleScope = (
  scopes: ReadonlyArray<PATScope>,
  scope: PATScope,
  checked: boolean
): ReadonlyArray<PATScope> =>
  checked ? [...scopes, scope] : scopes.filter((candidate) => candidate !== scope);

const LifetimeSelector = ({
  state,
  update,
}: Readonly<{
  state: Extract<PATCreationDisplay, { _tag: "Editing" }>;
  update: (state: Extract<PATCreationDisplay, { _tag: "Editing" }>) => void;
}>): JSX.Element => (
  <fieldset className="flex flex-col gap-3">
    <legend className="font-medium">Duración</legend>
    <ChoiceDropdown
      id="pat-lifetime"
      label="Duración del token"
      width="full"
      disabled={false}
      leading={null}
      triggerLabel={Option.none()}
      options={lifetimeOptions}
      value={String(state.lifetimeDays)}
      onChange={(value) => {
        const selected = lifetimeOptions.find((option) => option.value === value);
        if (selected !== undefined) update({ ...state, lifetimeDays: selected.lifetimeDays });
      }}
    />
  </fieldset>
);

const ScopeSelector = ({
  state,
  update,
}: Readonly<{
  state: Extract<PATCreationDisplay, { _tag: "Editing" }>;
  update: (state: Extract<PATCreationDisplay, { _tag: "Editing" }>) => void;
}>): JSX.Element => {
  const selectedScopes = new Set(state.scopes);
  return (
    <fieldset className="flex flex-col">
      <legend className="mb-2 font-medium">Permisos</legend>
      {scopeOptions.map((option) => (
        <label
          className="flex cursor-pointer items-start gap-3 border-b py-3 transition-colors hover:bg-muted/50 has-[[data-checked]]:bg-muted/50"
          htmlFor={`pat-scope-${option.scope}`}
          key={option.scope}
        >
          <Checkbox
            aria-label={`${option.label}: ${option.description}`}
            id={`pat-scope-${option.scope}`}
            checked={selectedScopes.has(option.scope)}
            onCheckedChange={(checked) =>
              update({ ...state, scopes: toggleScope(state.scopes, option.scope, checked) })
            }
          />
          <span>
            <span className="block font-medium">{option.label}</span>
            <span className="text-sm text-muted-foreground">{option.description}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
};

const GrantEditor = ({
  state,
  update,
  review,
}: Readonly<{
  state: Extract<PATCreationDisplay, { _tag: "Editing" }>;
  update: (state: Extract<PATCreationDisplay, { _tag: "Editing" }>) => void;
  review: () => void;
}>): JSX.Element => {
  const normalizedLabel = state.recipientLabel.trim();
  const normalizedLabelLength = countPATLabelCharacters(normalizedLabel);
  const valid =
    normalizedLabelLength >= 1 &&
    normalizedLabelLength <= recipientLabelLimit &&
    state.scopes.length > 0;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (valid) review();
  };

  return (
    <form className="flex flex-col gap-6" onSubmit={submit}>
      <div className="flex flex-col gap-2">
        <Label htmlFor="pat-recipient">Nombre</Label>
        <Input
          id="pat-recipient"
          onChange={(event) => update({ ...state, recipientLabel: event.target.value })}
          aria-describedby="pat-recipient-hint"
          autoComplete="off"
          placeholder="Ej. Mi agente personal"
          value={state.recipientLabel}
        />
        <p id="pat-recipient-hint" className="text-sm text-muted-foreground">
          Un nombre visible de 1 a 80 caracteres.
        </p>
      </div>
      <ScopeSelector state={state} update={update} />
      <LifetimeSelector state={state} update={update} />
      <Button disabled={!valid} type="submit">
        Crear token
      </Button>
    </form>
  );
};

const GrantReview = ({
  grant,
  issuing,
  confirm,
  edit,
}: Readonly<{
  grant: ReviewedManualPATGrant;
  issuing: boolean;
  confirm: () => void;
  edit: () => void;
}>): JSX.Element => (
  <section className="flex min-w-0 flex-col gap-5" aria-label="Revisión del token">
    <h3 className="text-lg font-semibold">Revisa el acceso</h3>
    <div className="flex min-w-0 flex-col gap-5">
      <dl className="grid gap-2 sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted-foreground">Nombre</dt>
        <dd className="font-medium">{grant.recipientLabel}</dd>
        <dt className="text-muted-foreground">Permisos</dt>
        <dd className="flex flex-wrap gap-2">
          {grant.scopes.map((scope) => (
            <Badge key={scope} variant="secondary">
              {scopeOptions.find((option) => option.scope === scope)?.label}
            </Badge>
          ))}
        </dd>
        <dt className="text-muted-foreground">Duración</dt>
        <dd className="font-medium">{grant.lifetimeDays} días</dd>
        <dt className="text-muted-foreground">Vencimiento estimado</dt>
        <dd className="font-medium">
          <time dateTime={DateTime.formatIso(grant.reviewExpiresAt)}>
            {patExpirationFormatter.format(DateTime.toDate(grant.reviewExpiresAt))}
          </time>
          <span className="block text-sm text-muted-foreground">
            El vencimiento exacto se calculará al crear el token, {grant.lifetimeDays} días después.
          </span>
        </dd>
      </dl>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button disabled={issuing} onClick={edit} type="button" variant="outline">
          Editar
        </Button>
        <Button disabled={issuing} onClick={confirm} type="button">
          {issuing ? "Creando token…" : "Confirmar y crear token"}
        </Button>
      </div>
    </div>
  </section>
);

const IssuedGrant = ({
  issued,
  copyToClipboard,
  reset,
}: Readonly<{
  issued: IssuedPAT;
  copyToClipboard: (onCopied: () => void) => void;
  reset: () => void;
}>): JSX.Element => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <Alert>
        <AlertTitle>Token creado</AlertTitle>
        <AlertDescription>
          Guárdalo ahora en tu agente. Al salir de esta vista no podrás volver a consultar el token
          completo.
        </AlertDescription>
      </Alert>
      <code className="break-all rounded-lg border bg-muted p-4 text-sm">
        {Redacted.value(issued.bearer)}
      </code>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          aria-live="polite"
          onClick={() => copyToClipboard(() => setCopied(true))}
          type="button"
        >
          {copied ? "Copiado" : "Copiar token"}
        </Button>
        <Button onClick={reset} type="button" variant="outline">
          Crear otro token
        </Button>
      </div>
    </div>
  );
};

const FailedState = ({
  retry,
}: Readonly<{
  retry: () => void;
}>): JSX.Element => (
  <div className="flex flex-col gap-4">
    <Alert variant="destructive">
      <AlertTitle>No pudimos crear el token</AlertTitle>
      <AlertDescription>
        No se pudo confirmar la creación. Vuelve a la revisión para intentarlo de nuevo.
      </AlertDescription>
    </Alert>
    <Button onClick={retry} type="button" variant="outline">
      Volver a la revisión
    </Button>
  </div>
);

const IdentityConfirmationState = ({
  state,
  actions,
}: Readonly<{
  state: Extract<PATCreationDisplay, { _tag: "IdentityConfirmation" }>;
  actions: PATCreationActions;
}>): JSX.Element => (
  <div className="flex flex-col gap-4">
    <Alert>
      <AlertTitle>Confirma tu identidad</AlertTitle>
      <AlertDescription>
        Para crear este token, confirma tu identidad con la misma cuenta. Conservaremos el nombre,
        los permisos y la duración para volver a la revisión.
      </AlertDescription>
    </Alert>
    {state.preservationFailed && (
      <p role="alert">
        No pudimos conservar el formulario. Permite el almacenamiento de esta pestaña e intenta de
        nuevo.
      </p>
    )}
    <Button type="button" onClick={actions.confirmIdentity}>
      Confirmar mi identidad
    </Button>
    <Button type="button" variant="outline" onClick={actions.edit}>
      Volver al formulario
    </Button>
  </div>
);

const CreationContent = ({
  state,
  actions,
}: Readonly<{ state: PATCreationDisplay; actions: PATCreationActions }>): JSX.Element => {
  switch (state._tag) {
    case "Editing":
      return <GrantEditor state={state} update={actions.update} review={actions.review} />;
    case "Reviewing":
    case "Issuing":
      return (
        <GrantReview
          grant={state.grant}
          issuing={state._tag === "Issuing"}
          confirm={actions.confirm}
          edit={actions.edit}
        />
      );
    case "IdentityConfirmation":
      return <IdentityConfirmationState state={state} actions={actions} />;
    case "IssueFailed":
      return <FailedState retry={actions.retry} />;
    case "Issued":
      return (
        <IssuedGrant issued={state.issued} copyToClipboard={actions.copy} reset={actions.reset} />
      );
  }
};
/** Renders the mounted issuance module without owning its transition protocol. */
export const ManualPATView = ({
  state,
  actions,
  lifecycleRef,
}: Readonly<{
  state: PATCreationDisplay;
  actions: PATCreationActions;
  lifecycleRef: RefCallback<HTMLElement>;
}>): JSX.Element => (
  <section
    id="create-pat"
    ref={lifecycleRef}
    className="flex min-w-0 flex-col gap-6"
    aria-labelledby="create-pat-title"
  >
    <header className="flex flex-col gap-1">
      <h2 id="create-pat-title" className="text-xl font-semibold tracking-tight">
        Crear token
      </h2>
      <p className="text-sm text-muted-foreground">
        Dale un nombre y elige solo los permisos que necesita tu agente.
      </p>
    </header>
    <CreationContent actions={actions} state={state} />
  </section>
);
