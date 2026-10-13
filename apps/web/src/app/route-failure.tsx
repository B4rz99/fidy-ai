import { type JSX } from "react";

/** Reload also replaces a cached rejected lazy import after a deployment changes its chunk. */
export const RouteFailure = (): JSX.Element => (
  <main role="alert" className="mx-auto max-w-lg space-y-4 p-6">
    <p>No pudimos cargar esta página. Recarga para volver a intentarlo.</p>
    <button type="button" onClick={() => window.location.reload()}>
      Recargar página
    </button>
  </main>
);
