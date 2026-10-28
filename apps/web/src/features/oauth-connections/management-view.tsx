import { DateTime, Option } from "effect";
import { type JSX, type ReactNode } from "react";
import type {
  OAuthConnectionId,
  OAuthConnectionList,
  OAuthConnectionMetadata,
} from "@/transport/client";
import { Button } from "@/ui/components/button";
import { Badge } from "@/ui/components/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/table";

const dateFormat = new Intl.DateTimeFormat("es-CO", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const Timestamp = ({ value }: Readonly<{ value: DateTime.Utc }>): JSX.Element => (
  <time dateTime={DateTime.formatIso(value)}>
    {dateFormat.format(DateTime.toDate(value)).replaceAll(" de ", " ")}
  </time>
);
const stateVariants = { active: "success", expired: "warning", revoked: "destructive" } as const;
const states = { active: "Activo", expired: "Vencido", revoked: "Revocado" } as const;
type ConnectionProps = Readonly<{
  connection: OAuthConnectionMetadata;
  busy: boolean;
  revoke: (id: OAuthConnectionId) => void;
}>;
const connectionDetails = (
  connection: OAuthConnectionMetadata
): ReadonlyArray<Readonly<{ label: string; value: ReactNode }>> => [
  {
    label: "Permisos",
    value: (
      <span className="text-muted-foreground">
        {connection.permissions.map((permission) => permission.label).join(" · ")}
      </span>
    ),
  },
  {
    label: "Estado",
    value: <Badge variant={stateVariants[connection.state]}>{states[connection.state]}</Badge>,
  },
  {
    label: "Vence",
    value: (
      <span className="tabular-nums">
        <Timestamp value={connection.expiresAt} />
      </span>
    ),
  },
];
const ConnectionAction = ({ connection, busy, revoke }: ConnectionProps): JSX.Element =>
  connection.state === "active" ? (
    <Button
      contentLayout="wrap"
      type="button"
      variant="destructive-text"
      size="label"
      aria-label="Revocar este agente"
      disabled={busy}
      onClick={() => revoke(connection.connectionId)}
    >
      Revocar
    </Button>
  ) : (
    <span className="text-xs text-muted-foreground">
      Para volver a conectarlo necesitas una nueva aprobación.
    </span>
  );
const ConnectionRow = (props: ConnectionProps): JSX.Element => (
  <TableRow data-connection-id={props.connection.connectionId}>
    <TableHead scope="row" density="compact" className="whitespace-normal">
      <span className="block font-semibold break-words">{props.connection.claimedClientName}</span>
    </TableHead>
    {connectionDetails(props.connection).map(({ label, value }) => (
      <TableCell key={label} density="compact">
        {value}
      </TableCell>
    ))}
    <TableCell density="compact">
      <ConnectionAction {...props} />
    </TableCell>
  </TableRow>
);
const ConnectionMobileItem = (props: ConnectionProps): JSX.Element => (
  <li>
    <h3>{props.connection.claimedClientName}</h3>
    <dl>
      {connectionDetails(props.connection).map(({ label, value }) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
    <div data-settings-item-action>
      <ConnectionAction {...props} />
    </div>
  </li>
);
const ConnectionList = ({
  connections,
  busy,
  revoke,
}: Omit<ConnectionProps, "connection"> &
  Readonly<{ connections: OAuthConnectionList["connections"] }>): JSX.Element =>
  connections.length === 0 ? (
    <p>No hay conexiones en esta página.</p>
  ) : (
    <>
      <div className="settings-table" data-settings-desktop>
        <Table aria-label="Conexiones MCP" className="min-w-[36rem]">
          <TableHeader>
            <TableRow>
              {["Nombre", "Permisos", "Estado", "Vence", "Acción"].map((label) => (
                <TableHead key={label} scope="col" density="compact">
                  {label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {connections.map((connection) => (
              <ConnectionRow key={connection.connectionId} {...{ connection, busy, revoke }} />
            ))}
          </TableBody>
        </Table>
      </div>
      <ul data-settings-mobile-list aria-label="Conexiones MCP">
        {connections.map((connection) => (
          <ConnectionMobileItem key={connection.connectionId} {...{ connection, busy, revoke }} />
        ))}
      </ul>
    </>
  );
/** Display names are unverified; absent activity does not prove no historical work. */
export const OAuthManagementView = ({
  list,
  busy,
  revoke,
  revokeAll,
  next,
}: Readonly<{
  list: OAuthConnectionList;
  busy: boolean;
  revoke: (id: OAuthConnectionId) => void;
  revokeAll: () => void;
  next: (id: OAuthConnectionId) => void;
}>): JSX.Element => (
  <section className="flex flex-col gap-4">
    <ConnectionList connections={list.connections} busy={busy} revoke={revoke} />
    <p className="text-sm text-muted-foreground">Los nombres son declarados por los agentes.</p>
    {Option.match(list.nextCursor, {
      onNone: () => null,
      onSome: (id) => (
        <Button
          contentLayout="wrap"
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => next(id)}
        >
          Siguiente página
        </Button>
      ),
    })}
    <div>
      <Button
        contentLayout="wrap"
        type="button"
        variant="destructive-text"
        size="label"
        aria-label="Revocar todos los agentes conectados"
        disabled={busy}
        onClick={revokeAll}
      >
        Revocar todos los agentes
      </Button>
    </div>
  </section>
);
