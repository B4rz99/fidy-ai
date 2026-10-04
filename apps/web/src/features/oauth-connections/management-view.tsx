import { DateTime, Option } from "effect";
import type { JSX } from "react";
import type {
  OAuthConnectionId,
  OAuthConnectionList,
  OAuthConnectionMetadata,
} from "@/transport/client";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/components/card";

const dateFormat = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Bogota",
});
const Timestamp = ({ value }: Readonly<{ value: DateTime.Utc }>): JSX.Element => (
  <time dateTime={DateTime.formatIso(value)}>{dateFormat.format(DateTime.toDate(value))}</time>
);
const states = { active: "Activo", expired: "Vencido", revoked: "Revocado" } as const;
const outcomes = { succeeded: "Completada", rejected: "Rechazada", failed: "Fallida" } as const;
const ConnectionCard = ({
  connection,
  busy,
  revoke,
}: Readonly<{
  connection: OAuthConnectionMetadata;
  busy: boolean;
  revoke: (id: OAuthConnectionId) => void;
}>): JSX.Element => (
  <Card>
    <CardHeader>
      <CardTitle className="break-words">{connection.claimedClientName}</CardTitle>
      <CardDescription>
        Nombre declarado; Fidy no verifica la identidad del cliente.
      </CardDescription>
    </CardHeader>
    <CardContent className="flex flex-col gap-3">
      <p className="break-all text-xs text-muted-foreground">Conexión: {connection.connectionId}</p>
      <p>Estado: {states[connection.state]}</p>
      <ul>
        {connection.permissions.map((permission) => (
          <li key={permission.scope}>{permission.label}</li>
        ))}
      </ul>
      <p>
        Vence: <Timestamp value={connection.expiresAt} />
      </p>
      <h3 className="font-medium">Actividad reciente</h3>
      {connection.recentActivity.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Sin llamadas registradas en la evidencia conservada.
        </p>
      ) : (
        <ul className="text-sm">
          {connection.recentActivity.map((activity) => (
            <li key={activity.id}>
              <code>{activity.operation}</code> — {outcomes[activity.outcome]} —{" "}
              <Timestamp value={activity.occurredAt} />
            </li>
          ))}
        </ul>
      )}
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
        <p className="text-sm">Para volver a conectarlo necesitas una nueva aprobación.</p>
      )}
    </CardContent>
  </Card>
);
/** A server-derived page: names are text, identity selects revocation, and absent evidence is not a claim of no historical work. */
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
    <p>
      Revocar detiene llamadas y renovaciones futuras; no deshace acciones ya realizadas. El acceso
      vencido o revocado requiere una nueva aprobación.
    </p>
    <p>
      Cerrar sesión y revocar tokens personales (PAT) son controles separados: no revocan estos
      agentes. Revocar agentes no cambia tus tokens personales ni la sesión del agente de Fidy.
    </p>
    <Button type="button" variant="destructive" disabled={busy} onClick={revokeAll}>
      Revocar todos los agentes conectados
    </Button>
    {list.connections.length === 0 ? (
      <p>No hay conexiones en esta página.</p>
    ) : (
      list.connections.map((connection) => (
        <ConnectionCard key={connection.connectionId} {...{ connection, busy, revoke }} />
      ))
    )}
    {Option.match(list.nextCursor, {
      onNone: () => null,
      onSome: (id) => (
        <Button type="button" variant="outline" disabled={busy} onClick={() => next(id)}>
          Siguiente página
        </Button>
      ),
    })}
  </section>
);
