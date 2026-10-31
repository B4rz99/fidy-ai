import { AccessListSkeleton } from "@/ui/components/settings-loading";
import { Key01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DateTime, Option } from "effect";
import { type JSX, type ReactNode, useState } from "react";
import {
  type ActivePATList,
  type ActivePATMetadata,
  type TokenShortId,
  patScopeCopy,
} from "@/transport/client";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/ui/components/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/table";
import { formatPATDate } from "./presentation";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";

export type RevokeActivePATCommand = Readonly<{
  shortId: TokenShortId;
  onRevoked: () => void;
  onFailed: () => void;
}>;

export type RevokeAllActivePATsCommand = Readonly<{
  onRevoked: (revokedCount: number) => void;
  onFailed: () => void;
}>;

export type ActivePATManagementState =
  | Readonly<{ _tag: "Initial" }>
  | Readonly<{ _tag: "Loading" }>
  | Readonly<{
      _tag: "LoadFailure";
      boundaryFailure: boolean;
      onRetry: () => void;
      waiting: boolean;
    }>
  | Readonly<{
      _tag: "Ready";
      result: ActivePATList;
      onRetry: () => void;
      refreshing: boolean;
      refreshFailed: boolean;
    }>;

type Selection = TokenShortId | "all";

const patDetails = (
  pat: ActivePATMetadata
): ReadonlyArray<Readonly<{ label: string; value: ReactNode }>> => [
  {
    label: "Permisos",
    value: (
      <span className="text-muted-foreground">
        {pat.scopes.map((scope) => patScopeCopy[scope].label).join(" · ")}
      </span>
    ),
  },
  {
    label: "Creado",
    value: <time dateTime={DateTime.formatIso(pat.createdAt)}>{formatPATDate(pat.createdAt)}</time>,
  },
  {
    label: "Último uso",
    value: Option.match(pat.lastUsedAt, {
      onNone: () => "Nunca",
      onSome: (lastUsedAt) => (
        <time dateTime={DateTime.formatIso(lastUsedAt)}>{formatPATDate(lastUsedAt)}</time>
      ),
    }),
  },
  {
    label: "Vence",
    value: <time dateTime={DateTime.formatIso(pat.expiresAt)}>{formatPATDate(pat.expiresAt)}</time>,
  },
];

const PATIdentity = ({ pat }: Readonly<{ pat: ActivePATMetadata }>): JSX.Element => (
  <>
    <span className="block break-words font-semibold">{pat.recipientLabel}</span>
    <code className="mt-1 block text-xs font-normal text-muted-foreground">{pat.shortId}</code>
  </>
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
    triggerText: string;
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
  triggerText,
  confirmation,
  confirmLabel,
  revokingLabel,
}: RevocationControlProps): JSX.Element => {
  if (!selected) {
    return (
      <Button
        contentLayout="wrap"
        aria-label={triggerLabel}
        disabled={disabled}
        onClick={select}
        type="button"
        variant="destructive-text"
        size="label"
      >
        {triggerText}
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-destructive/40 p-4">
      {confirmation}
      <div className="flex flex-wrap gap-2">
        <Button
          contentLayout="wrap"
          disabled={disabled || revoking}
          onClick={revoke}
          type="button"
          variant="destructive"
        >
          {revoking ? revokingLabel : confirmLabel}
        </Button>
        <Button
          contentLayout="wrap"
          disabled={revoking}
          onClick={cancel}
          type="button"
          variant="outline"
        >
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
        ¿Quieres desactivar el token <strong>{props.pat.recipientLabel}</strong>? Dejará de
        funcionar de inmediato.
      </p>
    }
    confirmLabel="Sí, desactivar"
    revokingLabel="Desactivando…"
    triggerLabel="Desactivar"
    triggerText="Desactivar"
  />
);

const PATRow = (props: Readonly<Parameters<typeof OneRevocationControl>[0]>): JSX.Element => (
  <>
    <TableRow>
      <TableHead scope="row" density="compact" className="whitespace-normal">
        <PATIdentity pat={props.pat} />
      </TableHead>
      {patDetails(props.pat).map(({ label, value }) => (
        <TableCell key={label} density="compact" className="tabular-nums">
          {value}
        </TableCell>
      ))}
      <TableCell density="compact" className="text-right">
        {!props.selected ? <OneRevocationControl {...props} /> : null}
      </TableCell>
    </TableRow>
    {props.selected ? (
      <TableRow>
        <TableCell colSpan={6} density="compact">
          <OneRevocationControl {...props} />
        </TableCell>
      </TableRow>
    ) : null}
  </>
);

const PATMobileItem = (
  props: Readonly<Parameters<typeof OneRevocationControl>[0]>
): JSX.Element => (
  <li>
    <h3>
      <PATIdentity pat={props.pat} />
    </h3>
    <dl>
      {patDetails(props.pat).map(({ label, value }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
    <div data-settings-item-action>
      <OneRevocationControl {...props} />
    </div>
  </li>
);

const AllRevocationControl = (props: RevocationActionProps): JSX.Element => (
  <RevocationControl
    {...props}
    confirmation={
      <p>
        ¿Quieres desactivar todos tus tokens? También se cancelarán los tokens pendientes de
        activación.
      </p>
    }
    confirmLabel="Sí, desactivar todos"
    revokingLabel="Desactivando todos…"
    triggerLabel="Desactivar todos los tokens"
    triggerText="Desactivar todos"
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
      onRevoked: () => complete("Token desactivado. Dejó de funcionar de inmediato."),
      onFailed: () =>
        fail(
          shortId,
          "No pudimos desactivar el token. Vuelve a cargar la página e inténtalo de nuevo."
        ),
    });
  };
  const revokeAll = (): void => {
    setState({ _tag: "Revoking", selection: "all" });
    input.revokeAll({
      onRevoked: (count) =>
        complete(
          count === 1 ? "Se desactivó 1 token activo." : `Se desactivaron ${count} tokens activos.`
        ),
      onFailed: () =>
        fail(
          "all",
          "No pudimos desactivar todos los tokens. Vuelve a cargar la página e inténtalo de nuevo."
        ),
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

const PATTableHeader = (): JSX.Element => (
  <>
    <colgroup>
      <col />
      <col />
      <col />
      <col />
      <col />
      <col className="w-32" />
    </colgroup>
    <TableHeader>
      <TableRow>
        {["Nombre", "Permisos", "Creado", "Último uso", "Vence", "Acción"].map((label) => (
          <TableHead key={label} scope="col" density="compact">
            {label}
          </TableHead>
        ))}
      </TableRow>
    </TableHeader>
  </>
);

const ReadyPATs = ({
  pats,
  controller,
  refreshing,
  refreshFailed,
}: Readonly<{
  pats: ActivePATList["pats"];
  controller: ReturnType<typeof useRevocationController>;
  refreshing: boolean;
  refreshFailed: boolean;
}>): JSX.Element => {
  const selected = controller.state._tag === "Idle" ? undefined : controller.state.selection;
  const revoking = controller.state._tag === "Revoking";
  const disabled = revoking || refreshing || refreshFailed;
  const rows = pats.map((pat) => ({
    pat,
    cancel: controller.cancel,
    disabled,
    revoke: (): void => controller.revokeOne(pat.shortId),
    revoking: revoking && selected === pat.shortId,
    select: (): void => controller.select(pat.shortId),
    selected: selected === pat.shortId,
  }));
  return (
    <>
      {pats.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No tienes tokens activos.</EmptyTitle>
            <EmptyDescription>
              Crea un token o autoriza a tu agente con su código para darle acceso a Fidy.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="settings-table" data-settings-desktop>
            <Table aria-labelledby="active-pats-title" className="min-w-[42rem]">
              <PATTableHeader />
              <TableBody>
                {rows.map((props) => (
                  <PATRow key={props.pat.shortId} {...props} />
                ))}
              </TableBody>
            </Table>
          </div>
          <ul data-settings-mobile-list aria-labelledby="active-pats-title">
            {rows.map((props) => (
              <PATMobileItem key={props.pat.shortId} {...props} />
            ))}
          </ul>
        </>
      )}
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
  if (state._tag === "Initial") {
    return <AccessListSkeleton kind="tokens" />;
  }
  if (state._tag === "Loading") return <AccessListSkeleton kind="tokens" />;
  if (state._tag === "Ready") {
    return (
      <>
        {state.refreshFailed ? (
          <CanonicalQueryRetry
            description="Mostramos los últimos tokens disponibles."
            onRetry={state.onRetry}
            retryLabel="Reintentar actualización"
            retryingLabel="Reintentando…"
            title="No pudimos actualizar tus tokens"
            waiting={state.refreshing}
          />
        ) : null}
        <ReadyPATs
          controller={controller}
          pats={state.result.pats}
          refreshing={state.refreshing}
          refreshFailed={state.refreshFailed}
        />
      </>
    );
  }
  return (
    <CanonicalQueryRetry
      description="Intenta de nuevo en unos momentos."
      onRetry={state.onRetry}
      retryLabel="Reintentar carga"
      retryingLabel="Reintentando…"
      title={
        state.boundaryFailure ? "No pudimos comunicarnos con Fidy" : "No pudimos cargar tus tokens"
      }
      waiting={state.waiting}
    />
  );
};

const ActivePATHeading = ({
  state,
  controller,
}: Readonly<{
  state: ActivePATManagementState;
  controller: RevocationController;
}>): JSX.Element => (
  <div className="settings-access-heading">
    <span className="settings-section-icon">
      <HugeiconsIcon icon={Key01Icon} size={28} strokeWidth={1.5} aria-hidden="true" />
    </span>
    <h2 className="settings-section-title" id="active-pats-title">
      Tokens activos
    </h2>
    {state._tag === "Ready" ? (
      <div
        className={
          controller.state._tag !== "Idle" && controller.state.selection === "all"
            ? "settings-access-confirmation"
            : "settings-access-bulk"
        }
      >
        <AllRevocationControl
          cancel={controller.cancel}
          disabled={controller.state._tag === "Revoking" || state.refreshing || state.refreshFailed}
          revoke={controller.revokeAll}
          revoking={controller.state._tag === "Revoking" && controller.state.selection === "all"}
          select={() => controller.select("all")}
          selected={controller.state._tag !== "Idle" && controller.state.selection === "all"}
        />
      </div>
    ) : null}
  </div>
);

/** Shows active-only metadata; revocation flows receive no bearer. */
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
    <section aria-labelledby="active-pats-title" className="settings-access-section">
      <ActivePATHeading state={state} controller={controller} />
      {controller.state._tag !== "Revoking" &&
        Option.match(controller.state.notice, {
          onNone: () => null,
          onSome: (notice) => (
            <Alert aria-live="polite">
              <AlertTitle>Tokens de acceso</AlertTitle>
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          ),
        })}
      <PATQueryContent controller={controller} state={state} />
    </section>
  );
};
