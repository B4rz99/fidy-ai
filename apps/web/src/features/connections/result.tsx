import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { type JSX, useState } from "react";
import type { CanonicalSuccess } from "@/transport/client";
import { presentCanonicalQuery } from "@/transport/canonical-query";

type Connection = CanonicalSuccess<"connections.listConnections">["data"][number];
const messages: Readonly<
  Record<Connection["state"], Readonly<{ title: string; description: string }>>
> = {
  Active: {
    title: "Bancolombia está conectado",
    description: "Tu conexión está activa. Las transacciones y los saldos aún no se han importado.",
  },
  Connecting: {
    title: "La conexión sigue pendiente",
    description:
      "No hemos confirmado una autorización válida de Bancolombia. Consultar el estado no vuelve a enviar la autorización.",
  },
  "Action required": {
    title: "No pudimos completar la conexión",
    description:
      "Esta solicitud no se volverá a enviar. Inicia una nueva conexión desde Fidy cuando quieras intentarlo de nuevo.",
  },
  Ended: {
    title: "La conexión terminó",
    description: "Fidy no tiene una conexión activa con Bancolombia.",
  },
};

const AuthorizedAccounts = ({ connection }: Readonly<{ connection: Connection }>): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const [query] = useState(() =>
    client.query("connections", "listAccounts", {
      params: { id: connection.id },
      timeToLive: "0 seconds",
    })
  );
  const result = useAtomValue(query).pipe(presentCanonicalQuery);
  if (result._tag !== "Ready") {
    return <p>La consulta de cuentas autorizadas aún no está disponible.</p>;
  }
  if (Option.isSome(result.refreshFailure)) {
    return <p>No pudimos actualizar las cuentas autorizadas.</p>;
  }
  return <p>Cuentas autorizadas: {result.value.data.length}.</p>;
};

export const ConnectionResult = ({
  connections,
}: Readonly<{ connections: ReadonlyArray<Connection> }>): JSX.Element => {
  const connection = Option.fromUndefinedOr(
    connections.find((item) => item.institutionId === "bancolombia")
  );
  if (Option.isNone(connection)) {
    return <p>No hay una conexión de Bancolombia registrada para esta cuenta de Fidy.</p>;
  }
  const message = messages[connection.value.state];
  return (
    <section className="flex flex-col gap-3" aria-live="polite">
      <h2 className="text-xl font-semibold">{message.title}</h2>
      <p>{message.description}</p>
      {connection.value.state === "Active" ? (
        <AuthorizedAccounts key={connection.value.id} connection={connection.value} />
      ) : null}
    </section>
  );
};
