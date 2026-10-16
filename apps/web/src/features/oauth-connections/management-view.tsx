import { DateTime, Option } from "effect";
import { type JSX } from "react";
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
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});
const Timestamp = ({ value }: Readonly<{ value: DateTime.Utc }>): JSX.Element => (
  <time dateTime={DateTime.formatIso(value)}>
    {dateFormat.format(DateTime.toDate(value)).replaceAll("/", "-")}
  </time>
);
const stateVariants = { active: "success", expired: "warning", revoked: "destructive" } as const;
const states = { active: "Activo", expired: "Vencido", revoked: "Revocado" } as const;
const ConnectionRow = ({
  connection,
  busy,
  revoke,
}: Readonly<{
  connection: OAuthConnectionMetadata;
  busy: boolean;
  revoke: (id: OAuthConnectionId) => void;
}>): JSX.Element => (
  <>
    <TableRow data-connection-id={connection.connectionId}>
      <TableCell density="compact">
        <span className="block font-semibold break-words">{connection.claimedClientName}</span>
      </TableCell>
      <TableCell density="compact">
        <div className="flex flex-wrap gap-1">
          {connection.permissions.map((permission) => (
            <Badge key={permission.scope} variant="secondary">
              {permission.label}
            </Badge>
          ))}
        </div>
      </TableCell>
      <TableCell density="compact">
        <Badge variant={stateVariants[connection.state]}>{states[connection.state]}</Badge>
      </TableCell>
      <TableCell density="compact" className="tabular-nums whitespace-nowrap">
        <Timestamp value={connection.expiresAt} />
      </TableCell>
      <TableCell density="compact">
        {connection.state === "active" ? (
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => revoke(connection.connectionId)}
          >
            Revocar este agente
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">
            Para volver a conectarlo necesitas una nueva aprobación.
          </span>
        )}
      </TableCell>
    </TableRow>
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
    {list.connections.length === 0 ? (
      <p>No hay conexiones en esta página.</p>
    ) : (
      <Table aria-label="Conexiones MCP">
        <TableHeader>
          <TableRow>
            {["Nombre", "Permisos", "Estado", "Vence el", "Acciones"].map((label) => (
              <TableHead key={label} density="compact">
                {label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.connections.map((connection) => (
            <ConnectionRow key={connection.connectionId} {...{ connection, busy, revoke }} />
          ))}
        </TableBody>
      </Table>
    )}
    {Option.match(list.nextCursor, {
      onNone: () => null,
      onSome: (id) => (
        <Button type="button" variant="outline" disabled={busy} onClick={() => next(id)}>
          Siguiente página
        </Button>
      ),
    })}
    <Button type="button" variant="destructive" disabled={busy} onClick={revokeAll}>
      Revocar todos los agentes conectados
    </Button>
  </section>
);
