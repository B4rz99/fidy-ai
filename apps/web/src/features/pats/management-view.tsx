import { PendingRead } from "@/ui/components/pending-read";

import { Key01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DateTime, Option } from "effect";
import { type JSX, type ReactNode, type RefCallback } from "react";
import { type ActivePATList, type ActivePATMetadata, patScopeCopy } from "@/transport/client";
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
import { type PATManagementActions, type PATManagementTask } from "./management";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";

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
        ¿Quieres desactivar el token <strong>{props.pat.recipientLabel}</strong> (
        <code>{props.pat.shortId}</code>)? Dejará de funcionar de inmediato.
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

type RevocationController = Readonly<{ state: PATManagementTask; actions: PATManagementActions }>;
const selectedAll = (state: PATManagementTask): boolean =>
  (state._tag === "Reviewing" || state._tag === "Revoking") && state.target._tag === "All";
const locked = (state: PATManagementTask): boolean =>
  state._tag !== "Ready" && state._tag !== "Reviewing";

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
  controller: RevocationController;
  refreshing: boolean;
  refreshFailed: boolean;
}>): JSX.Element => {
  const disabled = locked(controller.state) || refreshing || refreshFailed;
  const rows = pats.map((pat) => ({
    pat,
    cancel: controller.actions.cancel,
    disabled: disabled || controller.state._tag === "Reviewing",
    revoke: controller.actions.confirm,
    revoking: false,
    select: (): void => controller.actions.reviewOne(pat.shortId),
    selected: false,
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
  controller: RevocationController;
}>): JSX.Element => {
  if (state._tag === "Initial") {
    return <PendingRead label="Cargando tokens activos" />;
  }
  if (state._tag === "Loading") return <PendingRead label="Cargando tokens activos" />;
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
          selectedAll(controller.state) ? "settings-access-confirmation" : "settings-access-bulk"
        }
      >
        <AllRevocationControl
          cancel={controller.actions.cancel}
          disabled={
            locked(controller.state) ||
            state.refreshing ||
            state.refreshFailed ||
            (controller.state._tag === "Reviewing" && !selectedAll(controller.state))
          }
          revoke={controller.actions.confirm}
          revoking={controller.state._tag === "Revoking" && selectedAll(controller.state)}
          select={controller.actions.reviewAll}
          selected={selectedAll(controller.state)}
        />
      </div>
    ) : null}
  </div>
);

const outcomeMessage = (state: PATManagementTask): Option.Option<string> => {
  if (state._tag === "Revoking") return Option.none();
  if (state._tag === "Uncertain" || state._tag === "Refreshing") {
    return Option.some(
      "No recibimos un resultado confirmado. Actualiza los tokens antes de revisar otra desactivación. La actualización no repite la solicitud."
    );
  }
  return Option.map(state.outcome, (outcome) => {
    switch (outcome._tag) {
      case "One":
        return `Token desactivado. Dejó de funcionar de inmediato. Identificador: ${outcome.shortId}.`;
      case "All":
        return outcome.revokedCount === 1
          ? "Se desactivó 1 token activo."
          : `Se desactivaron ${outcome.revokedCount} tokens activos.`;
      case "Observed": {
        if (outcome.target._tag === "All") {
          return "La lista está actualizada. El resultado de la desactivación anterior y su cantidad siguen sin confirmar; la lista no confirma el cierre de autorizaciones pendientes.";
        }
        return outcome.active
          ? "El token figura activo. El resultado de la desactivación anterior sigue sin confirmar."
          : "El token ya no figura activo. Esto no confirma el resultado de la desactivación anterior.";
      }
      case "Refused":
        return {
          Authority:
            "No se admitió la desactivación. Confirma tu identidad antes de revisar otra solicitud.",
          Consent:
            "No se admitió la desactivación. Revisa tu autorización de tratamiento en Privacidad.",
          NotFound: "No se encontró ese token. Actualiza la lista antes de revisar otra solicitud.",
          Limited:
            "No se admitió la desactivación por el límite de solicitudes. Espera antes de revisar otra solicitud.",
          Input: "No se admitió la desactivación. Actualiza la lista y revisa la solicitud.",
        }[outcome.reason];
    }
  });
};

/** Shows active-only metadata and distinguishes command receipts from current observations. */
export const ActivePATManagementView = ({
  state,
  task,
  actions,
  lifecycleRef,
}: Readonly<{
  state: ActivePATManagementState;
  task: PATManagementTask;
  actions: PATManagementActions;
  lifecycleRef: RefCallback<HTMLElement>;
}>): JSX.Element => {
  const controller = { state: task, actions };
  return (
    <section
      aria-labelledby="active-pats-title"
      className="settings-access-section"
      ref={lifecycleRef}
    >
      <ActivePATHeading state={state} controller={controller} />
      {Option.match(outcomeMessage(task), {
        onNone: () => null,
        onSome: (notice) => (
          <Alert aria-live="polite">
            <AlertTitle>
              {task._tag === "Uncertain" || task._tag === "Refreshing"
                ? "Desactivación sin confirmar"
                : "Tokens de acceso"}
            </AlertTitle>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ),
      })}
      {(task._tag === "Reviewing" || task._tag === "Revoking") && task.target._tag === "One" ? (
        <OneRevocationControl
          pat={task.target.pat}
          selected
          disabled={
            task._tag === "Revoking" ||
            state._tag !== "Ready" ||
            state.refreshing ||
            state.refreshFailed
          }
          revoking={task._tag === "Revoking"}
          select={actions.confirm}
          cancel={actions.cancel}
          revoke={actions.confirm}
        />
      ) : null}
      <PATQueryContent controller={controller} state={state} />
    </section>
  );
};
