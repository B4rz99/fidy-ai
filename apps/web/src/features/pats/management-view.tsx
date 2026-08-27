import { DateTime, Option } from "effect";
import { type JSX, useState } from "react";
import type { ActivePATList, ActivePATMetadata, TokenShortId } from "@/transport/client";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/components/card";

/** Terminal callbacks for revoking one PAT selected by its safe short id. */
export type RevokeActivePATCommand = Readonly<{
  shortId: TokenShortId;
  onRevoked: () => void;
  onFailed: () => void;
}>;

/** Terminal callbacks for revoking every active or claimable PAT authorization. */
export type RevokeAllActivePATsCommand = Readonly<{
  onRevoked: (revokedCount: number) => void;
  onFailed: () => void;
}>;

/** Query state derived by the owning typed HttpApi atom. */
export type ActivePATManagementState =
  | Readonly<{ _tag: "Loading" }>
  | Readonly<{ _tag: "LoadFailure" }>
  | Readonly<{ _tag: "Ready"; result: ActivePATList }>;

type Selection = TokenShortId | "all";

const instantFormatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const formatInstant = (instant: DateTime.Utc): string =>
  `${instantFormatter.format(DateTime.toDate(instant))} UTC`;

const PATMetadata = ({ pat }: Readonly<{ pat: ActivePATMetadata }>): JSX.Element => (
  <dl className="grid gap-2 sm:grid-cols-[9rem_1fr]">
    <dt className="text-muted-foreground">Identificador</dt>
    <dd>
      <code>{pat.shortId}</code>
    </dd>
    <dt className="text-muted-foreground">Alcances</dt>
    <dd className="flex flex-wrap gap-2">
      {pat.scopes.map((scope) => (
        <Badge key={scope} variant="secondary">
          {scope}
        </Badge>
      ))}
    </dd>
    <dt className="text-muted-foreground">Creado</dt>
    <dd>
      <time dateTime={DateTime.formatIso(pat.createdAt)}>{formatInstant(pat.createdAt)}</time>
    </dd>
    <dt className="text-muted-foreground">Último uso</dt>
    <dd>
      {Option.match(pat.lastUsedAt, {
        onNone: () => "Sin uso",
        onSome: (lastUsedAt) => (
          <time dateTime={DateTime.formatIso(lastUsedAt)}>{formatInstant(lastUsedAt)}</time>
        ),
      })}
    </dd>
    <dt className="text-muted-foreground">Vence</dt>
    <dd>
      <time dateTime={DateTime.formatIso(pat.expiresAt)}>{formatInstant(pat.expiresAt)}</time>
    </dd>
  </dl>
);

type RevocationActionProps = Readonly<{
  selected: boolean;
  disabled: boolean;
  revoking: boolean;
  select: () => void;
  cancel: () => void;
  revoke: () => void;
}>;

type RevocationControlProps = RevocationActionProps &
  Readonly<{
    triggerLabel: string;
    triggerVariant: "outline" | "destructive";
    confirmation: JSX.Element;
    confirmLabel: string;
    revokingLabel: string;
  }>;

const RevocationControl = ({
  selected,
  disabled,
  revoking,
  select,
  cancel,
  revoke,
  triggerLabel,
  triggerVariant,
  confirmation,
  confirmLabel,
  revokingLabel,
}: RevocationControlProps): JSX.Element => {
  if (!selected) {
    return (
      <Button disabled={disabled} onClick={select} type="button" variant={triggerVariant}>
        {triggerLabel}
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-destructive/40 p-4">
      {confirmation}
      <div className="flex flex-wrap gap-2">
        <Button disabled={revoking} onClick={revoke} type="button" variant="destructive">
          {revoking ? revokingLabel : confirmLabel}
        </Button>
        <Button disabled={revoking} onClick={cancel} type="button" variant="outline">
          Cancelar
        </Button>
      </div>
    </div>
  );
};

const OneRevocationControl = (
  props: RevocationActionProps & Readonly<{ pat: ActivePATMetadata }>
): JSX.Element => (
  <RevocationControl
    {...props}
    confirmation={
      <p>
        Confirma que quieres revocar <strong>{props.pat.recipientLabel}</strong>. Este PAT dejará de
        funcionar inmediatamente.
      </p>
    }
    confirmLabel="Confirmar revocación"
    revokingLabel="Revocando…"
    triggerLabel="Revocar"
    triggerVariant="outline"
  />
);

const PATCard = (props: Readonly<Parameters<typeof OneRevocationControl>[0]>): JSX.Element => (
  <Card>
    <CardHeader>
      <CardTitle>
        <h3>{props.pat.recipientLabel}</h3>
      </CardTitle>
    </CardHeader>
    <CardContent className="flex flex-col gap-4">
      <PATMetadata pat={props.pat} />
      <OneRevocationControl {...props} />
    </CardContent>
  </Card>
);

const AllRevocationControl = (props: RevocationActionProps): JSX.Element => (
  <RevocationControl
    {...props}
    confirmation={
      <p>
        Confirma que quieres revocar todos los PATs. También se cancelará cualquier PAT aprobado que
        todavía no haya sido reclamado.
      </p>
    }
    confirmLabel="Confirmar revocación total"
    revokingLabel="Revocando todos…"
    triggerLabel="Revocar todos los PATs"
    triggerVariant="destructive"
  />
);

type RevocationState =
  | Readonly<{ _tag: "Idle"; notice: Option.Option<string> }>
  | Readonly<{
      _tag: "Confirming";
      selection: Selection;
      notice: Option.Option<string>;
    }>
  | Readonly<{ _tag: "Revoking"; selection: Selection }>;

type RevocationController = Readonly<{
  state: RevocationState;
  select: (selection: Selection) => void;
  cancel: () => void;
  revokeOne: (shortId: TokenShortId) => void;
  revokeAll: () => void;
}>;

const useRevocationController = (input: {
  readonly revokeOne: (command: RevokeActivePATCommand) => void;
  readonly revokeAll: (command: RevokeAllActivePATsCommand) => void;
}): RevocationController => {
  const [state, setState] = useState<RevocationState>({ _tag: "Idle", notice: Option.none() });
  const complete = (message: string): void => {
    setState({ _tag: "Idle", notice: Option.some(message) });
  };
  const fail = (selection: Selection, message: string): void => {
    setState({ _tag: "Confirming", selection, notice: Option.some(message) });
  };
  const revokeOne = (shortId: TokenShortId): void => {
    setState({ _tag: "Revoking", selection: shortId });
    input.revokeOne({
      shortId,
      onRevoked: () => complete("PAT revocado. El acceso quedó deshabilitado inmediatamente."),
      onFailed: () =>
        fail(shortId, "No pudimos revocar el PAT. Actualiza la lista e inténtalo de nuevo."),
    });
  };
  const revokeAll = (): void => {
    setState({ _tag: "Revoking", selection: "all" });
    input.revokeAll({
      onRevoked: (count) =>
        complete(count === 1 ? "Se revocó 1 PAT activo." : `Se revocaron ${count} PATs activos.`),
      onFailed: () =>
        fail("all", "No pudimos revocar todos los PATs. Actualiza la lista e inténtalo de nuevo."),
    });
  };
  return {
    state,
    select: (selection) => setState({ _tag: "Confirming", selection, notice: Option.none() }),
    cancel: () => setState({ _tag: "Idle", notice: Option.none() }),
    revokeOne,
    revokeAll,
  };
};

const ReadyPATs = ({
  pats,
  controller,
}: Readonly<{
  pats: ActivePATList["pats"];
  controller: ReturnType<typeof useRevocationController>;
}>): JSX.Element => {
  const selected = controller.state._tag === "Idle" ? undefined : controller.state.selection;
  const revoking = controller.state._tag === "Revoking";
  return (
    <>
      {pats.length === 0 ? (
        <p className="rounded-lg border p-4 text-muted-foreground">No tienes PATs activos.</p>
      ) : (
        <div className="grid gap-4">
          {pats.map((pat) => (
            <PATCard
              cancel={controller.cancel}
              disabled={revoking}
              key={pat.shortId}
              pat={pat}
              revoke={() => controller.revokeOne(pat.shortId)}
              revoking={revoking && selected === pat.shortId}
              select={() => controller.select(pat.shortId)}
              selected={selected === pat.shortId}
            />
          ))}
        </div>
      )}
      <AllRevocationControl
        cancel={controller.cancel}
        disabled={revoking}
        revoke={controller.revokeAll}
        revoking={revoking && selected === "all"}
        select={() => controller.select("all")}
        selected={selected === "all"}
      />
    </>
  );
};

const PATQueryContent = ({
  state,
  controller,
}: Readonly<{
  state: ActivePATManagementState;
  controller: ReturnType<typeof useRevocationController>;
}>): JSX.Element => {
  if (state._tag === "Loading") return <p aria-live="polite">Cargando PATs activos…</p>;
  if (state._tag === "Ready") return <ReadyPATs controller={controller} pats={state.result.pats} />;
  return (
    <Alert variant="destructive">
      <AlertTitle>No pudimos cargar tus PATs</AlertTitle>
      <AlertDescription>Vuelve a abrir esta página para intentarlo de nuevo.</AlertDescription>
    </Alert>
  );
};

/** Renders active-only PAT metadata and explicit one/all revocation flows without bearer access. */
export const ActivePATManagementView = ({
  state,
  revokeOne,
  revokeAll,
}: Readonly<{
  state: ActivePATManagementState;
  revokeOne: (command: RevokeActivePATCommand) => void;
  revokeAll: (command: RevokeAllActivePATsCommand) => void;
}>): JSX.Element => {
  const controller = useRevocationController({ revokeOne, revokeAll });
  return (
    <section aria-labelledby="active-pats-title" className="flex flex-col gap-5">
      <div>
        <h2 className="text-xl font-semibold" id="active-pats-title">
          PATs activos
        </h2>
        <p className="text-sm text-muted-foreground">
          Solo se muestran metadatos seguros; los tokens secretos nunca se pueden volver a ver.
        </p>
      </div>
      {controller.state._tag !== "Revoking" &&
        Option.match(controller.state.notice, {
          onNone: () => null,
          onSome: (notice) => (
            <Alert aria-live="polite">
              <AlertTitle>Administración de PATs</AlertTitle>
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          ),
        })}
      <PATQueryContent controller={controller} state={state} />
    </section>
  );
};
