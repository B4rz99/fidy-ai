import type { JSX } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";

export const LogoutFailure = (): JSX.Element => (
  <Alert className="m-3" variant="destructive" role="alert">
    <AlertTitle>No pudimos confirmar el cierre de sesión</AlertTitle>
    <AlertDescription>Revisa tu conexión e intenta cerrar sesión de nuevo.</AlertDescription>
  </Alert>
);
