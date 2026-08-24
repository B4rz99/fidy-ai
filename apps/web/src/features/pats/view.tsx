import {
  type IssuedManualPAT,
  type ManualPATGrantInput,
  ManualPATRequestId,
  type ManualPATRequestId as ManualPATRequestIdType,
  PATRecipientLabel,
  PATScope,
  PATScopes,
  type TokenBearer,
  buildPATDisclosure,
  countPATLabelCharacters,
  patScopeCopy,
  recipientLabelLimit,
} from "@/transport/client";
import { Duration } from "effect";
import { bearerRevealLifetime } from "./policy";
import {
  type Dispatch,
  type FormEvent,
  type JSX,
  type RefCallback,
  type SetStateAction,
  useCallback,
  useState,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/components/card";
import { Checkbox } from "@/ui/components/checkbox";
import { Input } from "@/ui/components/input";

type IssuedPAT = typeof IssuedManualPAT.Type;
type PATScopeValue = (typeof PATScopes.Type)[number];

/** One confirmed manual PAT request plus callbacks for its terminal server outcome. */
export type IssueManualPATCommand = Readonly<{
  grant: ManualPATGrantInput;
  requestId: ManualPATRequestIdType;
  onIssued: (issued: IssuedPAT) => void;
  onFailed: () => void;
}>;

/** Closed UI lifecycle that prevents issuance before exact grant review. */
export type ManualPATCreationState =
  | Readonly<{ _tag: "Editing"; recipientLabel: string; scopes: ReadonlyArray<PATScopeValue> }>
  | Readonly<{
      _tag: "Reviewing";
      grant: ManualPATGrantInput;
      requestId: ManualPATRequestIdType;
    }>
  | Readonly<{ _tag: "Issuing"; grant: ManualPATGrantInput; requestId: ManualPATRequestIdType }>
  | Readonly<{
      _tag: "IssueFailed";
      grant: ManualPATGrantInput;
      requestId: ManualPATRequestIdType;
    }>
  | Readonly<{ _tag: "Issued"; issued: IssuedPAT }>;

const bearerRevealLifetimeMs = Duration.toMillis(bearerRevealLifetime);

const initialState: ManualPATCreationState = {
  _tag: "Editing",
  recipientLabel: "",
  scopes: [],
};

const scopeOptions = Object.entries(patScopeCopy).map(([scope, details]) => ({
  scope: PATScope.make(scope),
  ...details,
}));

const toggleScope = (
  scopes: ReadonlyArray<PATScopeValue>,
  scope: PATScopeValue,
  checked: boolean
): ReadonlyArray<PATScope> =>
  checked ? [...scopes, scope] : scopes.filter((candidate) => candidate !== scope);

const ScopeSelector = ({
  state,
  update,
}: Readonly<{
  state: Extract<ManualPATCreationState, { _tag: "Editing" }>;
  update: (state: Extract<ManualPATCreationState, { _tag: "Editing" }>) => void;
}>): JSX.Element => (
  <fieldset className="flex flex-col gap-3">
    <legend className="font-medium">Alcances</legend>
    {scopeOptions.map((option) => (
      <label
        className="flex cursor-pointer items-start gap-3 rounded-lg border p-4"
        htmlFor={`pat-scope-${option.scope}`}
        key={option.scope}
      >
        <Checkbox
          aria-label={`${option.label}: ${option.description}`}
          id={`pat-scope-${option.scope}`}
          checked={state.scopes.includes(option.scope)}
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

const GrantEditor = ({
  state,
  update,
  review,
}: Readonly<{
  state: Extract<ManualPATCreationState, { _tag: "Editing" }>;
  update: (state: Extract<ManualPATCreationState, { _tag: "Editing" }>) => void;
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
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Nuevo PAT</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-6" onSubmit={submit}>
          <div className="flex flex-col gap-2">
            <label className="font-medium" htmlFor="pat-recipient">
              Destinatario
            </label>
            <Input
              id="pat-recipient"
              onChange={(event) => update({ ...state, recipientLabel: event.target.value })}
              placeholder="Ej. Automatización casa"
              value={state.recipientLabel}
            />
            <p className="text-sm text-muted-foreground">
              Una etiqueta visible de 1 a 80 caracteres; no verifica la identidad del destinatario.
            </p>
          </div>
          <ScopeSelector state={state} update={update} />
          <Button disabled={!valid} type="submit">
            Revisar PAT
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

const GrantReview = ({
  grant,
  issuing,
  confirm,
  edit,
}: Readonly<{
  grant: ManualPATGrantInput;
  issuing: boolean;
  confirm: () => void;
  edit: () => void;
}>): JSX.Element => (
  <Card>
    <CardHeader>
      <CardTitle>
        <h2>Revisa el acceso</h2>
      </CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col gap-5">
      <dl className="grid gap-2 sm:grid-cols-[10rem_1fr]">
        <dt className="text-muted-foreground">Destinatario</dt>
        <dd className="font-medium">{grant.recipientLabel}</dd>
        <dt className="text-muted-foreground">Alcances</dt>
        <dd className="flex flex-wrap gap-2">
          {grant.scopes.map((scope) => (
            <Badge key={scope} variant="secondary">
              {scopeOptions.find((option) => option.scope === scope)?.label}
            </Badge>
          ))}
        </dd>
      </dl>
      <section aria-label="Divulgación exacta del PAT">
        <p className="whitespace-pre-line text-sm text-muted-foreground">
          {buildPATDisclosure(grant)}
        </p>
      </section>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button disabled={issuing} onClick={edit} type="button" variant="outline">
          Editar
        </Button>
        <Button disabled={issuing} onClick={confirm} type="button">
          {issuing ? "Creando PAT…" : "Confirmar y crear PAT"}
        </Button>
      </div>
    </CardContent>
  </Card>
);

const IssuedGrant = ({
  issued,
  copyToClipboard,
  reset,
}: Readonly<{
  issued: IssuedPAT;
  copyToClipboard: (bearer: TokenBearer) => void;
  reset: () => void;
}>): JSX.Element => (
  <Card>
    <CardHeader>
      <CardTitle>
        <h2>Guarda este PAT ahora</h2>
      </CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col gap-5">
      <Alert>
        <AlertTitle>Se muestra una sola vez</AlertTitle>
        <AlertDescription>
          Fidy no puede recuperar este valor. Guárdalo directamente en el administrador seguro del
          destinatario.
        </AlertDescription>
      </Alert>
      <code className="break-all rounded-lg border bg-muted p-4 text-sm">{issued.bearer}</code>
      <p className="text-sm text-muted-foreground">
        Identificador seguro: <strong>{issued.pat.shortId}</strong>
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button onClick={() => copyToClipboard(issued.bearer)} type="button">
          Copiar PAT
        </Button>
        <Button onClick={reset} type="button" variant="outline">
          Crear otro PAT
        </Button>
      </div>
    </CardContent>
  </Card>
);

type SetCreationState = Dispatch<SetStateAction<ManualPATCreationState>>;

const revealIssuedPAT = (
  issued: IssuedPAT,
  setState: SetCreationState,
  clearClipboard: (bearer: TokenBearer) => void
): void => {
  setState({ _tag: "Issued", issued });
  setTimeout(() => {
    clearClipboard(issued.bearer);
    setState((current) =>
      current._tag === "Issued" && current.issued.pat.id === issued.pat.id ? initialState : current
    );
  }, bearerRevealLifetimeMs);
};

const EditingState = ({
  state,
  setState,
}: Readonly<{
  state: Extract<ManualPATCreationState, { _tag: "Editing" }>;
  setState: SetCreationState;
}>): JSX.Element => (
  <GrantEditor
    review={() =>
      setState({
        _tag: "Reviewing",
        grant: {
          recipientLabel: PATRecipientLabel.make(state.recipientLabel.trim()),
          scopes: PATScopes.make(state.scopes),
        },
        requestId: ManualPATRequestId.make(crypto.randomUUID()),
      })
    }
    state={state}
    update={setState}
  />
);

const ReviewState = ({
  state,
  setState,
  issue,
  clearClipboard,
}: Readonly<{
  state: Extract<ManualPATCreationState, { _tag: "Reviewing" | "Issuing" }>;
  setState: SetCreationState;
  issue: (command: IssueManualPATCommand) => void;
  clearClipboard: (bearer: TokenBearer) => void;
}>): JSX.Element => (
  <GrantReview
    confirm={() => {
      const { grant, requestId } = state;
      setState({ _tag: "Issuing", grant, requestId });
      issue({
        grant,
        requestId,
        onIssued: (issued) => revealIssuedPAT(issued, setState, clearClipboard),
        onFailed: () => setState({ _tag: "IssueFailed", grant, requestId }),
      });
    }}
    edit={() =>
      setState({
        _tag: "Editing",
        recipientLabel: state.grant.recipientLabel,
        scopes: state.grant.scopes,
      })
    }
    grant={state.grant}
    issuing={state._tag === "Issuing"}
  />
);

const FailedState = ({
  state,
  setState,
}: Readonly<{
  state: Extract<ManualPATCreationState, { _tag: "IssueFailed" }>;
  setState: SetCreationState;
}>): JSX.Element => (
  <div className="flex flex-col gap-4">
    <Alert variant="destructive">
      <AlertTitle>No pudimos crear el PAT</AlertTitle>
      <AlertDescription>
        Vuelve a emparejar el navegador si pasaron diez minutos y luego intenta de nuevo.
      </AlertDescription>
    </Alert>
    <Button
      onClick={() =>
        setState({ _tag: "Reviewing", grant: state.grant, requestId: state.requestId })
      }
      type="button"
      variant="outline"
    >
      Volver a la revisión
    </Button>
  </div>
);

const CreationContent = ({
  state,
  setState,
  issue,
  copyToClipboard,
  clearClipboard,
}: Readonly<{
  state: ManualPATCreationState;
  setState: SetCreationState;
  issue: (command: IssueManualPATCommand) => void;
  copyToClipboard: (bearer: TokenBearer) => void;
  clearClipboard: (bearer: TokenBearer) => void;
}>): JSX.Element => {
  if (state._tag === "Editing") return <EditingState setState={setState} state={state} />;
  if (state._tag === "Reviewing" || state._tag === "Issuing") {
    return (
      <ReviewState
        clearClipboard={clearClipboard}
        issue={issue}
        setState={setState}
        state={state}
      />
    );
  }
  if (state._tag === "IssueFailed") return <FailedState setState={setState} state={state} />;
  return (
    <IssuedGrant
      copyToClipboard={copyToClipboard}
      issued={state.issued}
      reset={() => {
        clearClipboard(state.issued.bearer);
        setState(initialState);
      }}
    />
  );
};

/** Guides one exact PAT grant from editing through review and one-time disclosure. */
export const ManualPATView = ({
  issue,
  copyToClipboard,
  clearClipboard,
}: Readonly<{
  issue: (command: IssueManualPATCommand) => void;
  copyToClipboard: (bearer: TokenBearer) => void;
  clearClipboard: (bearer: TokenBearer) => void;
}>): JSX.Element => {
  const [state, setState] = useState<ManualPATCreationState>(initialState);
  const lifecycleRef: RefCallback<HTMLElement> = useCallback(
    (node) => {
      if (node === null || state._tag !== "Issued") return;
      const clearBearer = (): void => {
        clearClipboard(state.issued.bearer);
        setState(initialState);
      };
      window.addEventListener("pagehide", clearBearer);
      return (): void => {
        window.removeEventListener("pagehide", clearBearer);
        clearBearer();
      };
    },
    [clearClipboard, state]
  );
  return (
    <main
      ref={lifecycleRef}
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8"
    >
      <header className="flex flex-col gap-2">
        <Badge className="w-fit" variant="secondary">
          Seguridad
        </Badge>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Tokens de acceso</h1>
        <p className="text-muted-foreground">
          Crea un PAT con el acceso mínimo que necesita su destinatario.
        </p>
      </header>
      <CreationContent
        clearClipboard={clearClipboard}
        copyToClipboard={copyToClipboard}
        issue={issue}
        setState={setState}
        state={state}
      />
    </main>
  );
};
