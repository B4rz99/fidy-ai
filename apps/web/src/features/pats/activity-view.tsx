import { DateTime, Option, Schema } from "effect";
import { type FormEvent, type JSX, useState } from "react";
import { type PATActivity, TokenShortId } from "@/transport/client";
import type { CanonicalQueryState } from "@/transport/canonical-query";
import { CanonicalQueryRetry } from "@/ui/canonical-query-feedback";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/components/card";
import { Input } from "@/ui/components/input";

/** Select a grant by its safe naming code; selection does not confer authority. */
export const PATActivityPicker = ({
  onSelect,
}: Readonly<{
  onSelect: (shortId: TokenShortId) => void;
}>): JSX.Element => {
  const [draft, setDraft] = useState("");
  const [attempted, setAttempted] = useState(false);
  const selected = Schema.decodeOption(TokenShortId)(draft.trim());
  const invalid = attempted && Option.isNone(selected);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setAttempted(true);
    if (Option.isSome(selected)) onSelect(selected.value);
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Actividad de un token</CardTitle>
        <CardDescription>
          Usa el código de ocho caracteres que aparece en tus tokens. También puedes consultar
          tokens vencidos o desactivados.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <label htmlFor="pat-activity-code">Código del token</label>
          <Input
            aria-describedby={invalid ? "pat-activity-invalid" : undefined}
            aria-invalid={invalid}
            autoComplete="off"
            id="pat-activity-code"
            onChange={(event) => setDraft(event.target.value)}
            value={draft}
          />
          {invalid ? (
            <p id="pat-activity-invalid" role="alert">
              Ingresa un código válido de ocho caracteres.
            </p>
          ) : null}
          <Button type="submit">Consultar actividad</Button>
        </form>
      </CardContent>
    </Card>
  );
};

const outcomes = { succeeded: "Completada", rejected: "Rechazada", failed: "Fallida" } as const;
const Timestamp = ({ value }: Readonly<{ value: DateTime.Utc }>): JSX.Element => (
  <time dateTime={DateTime.formatIso(value)}>{DateTime.formatIso(value)}</time>
);

type ActivityResultProps = Readonly<{
  state: CanonicalQueryState<PATActivity, unknown>;
  onRetry: () => void;
}>;

const ReadyActivity = ({
  state,
  onRetry,
}: ActivityResultProps &
  Readonly<{
    state: Extract<CanonicalQueryState<PATActivity, unknown>, { _tag: "Ready" }>;
  }>): JSX.Element => {
  const history = state.value;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Actividad de {history.pat.recipientLabel}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p>
          Código: <code>{history.pat.shortId}</code>
        </p>
        {Option.isSome(history.pat.revokedAt) ? <p>Token desactivado.</p> : null}
        <p>
          Historial disponible desde <Timestamp value={history.retainedSince} /> UTC. El historial
          no demuestra que el token nunca se haya usado; la actividad anterior puede haber dejado de
          conservarse.
        </p>
        {state.waiting ? <p aria-live="polite">Actualizando actividad…</p> : null}
        {Option.isSome(state.refreshFailure) ? (
          <CanonicalQueryRetry
            description="Mostramos la última actividad disponible."
            onRetry={onRetry}
            retryLabel="Reintentar actualización"
            retryingLabel="Reintentando…"
            title="No pudimos actualizar la actividad"
            waiting={state.waiting}
          />
        ) : null}
        {history.entries.length === 0 ? (
          <p>No hay actividad retenida para este token.</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {history.entries.map((entry, index) => (
              <li key={`${DateTime.formatIso(entry.occurredAt)}:${entry.operation}:${index}`}>
                <code>{entry.operation}</code> — {outcomes[entry.outcome]} —{" "}
                <Timestamp value={entry.occurredAt} /> UTC
              </li>
            ))}
          </ol>
        )}
        {history.hasMore ? (
          <p>Hay más actividad retenida. Mostramos las 50 entradas más recientes.</p>
        ) : null}
        <Button disabled={state.waiting} onClick={onRetry} type="button" variant="outline">
          Actualizar actividad
        </Button>
      </CardContent>
    </Card>
  );
};

/** Render only canonical activity metadata, preserving prior results during refresh and explaining retention limits. */
export const PATActivityResults = ({ state, onRetry }: ActivityResultProps): JSX.Element => {
  if (state._tag === "Initial") return <p aria-live="polite">Cargando actividad…</p>;
  if (state._tag === "Failure") {
    return (
      <CanonicalQueryRetry
        description="Comprueba el código del token e inténtalo de nuevo."
        onRetry={onRetry}
        retryLabel="Reintentar"
        retryingLabel="Reintentando…"
        title="No pudimos consultar la actividad"
        waiting={state.waiting}
      />
    );
  }
  return <ReadyActivity state={state} onRetry={onRetry} />;
};
