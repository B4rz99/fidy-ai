import { type ErrorComponentProps, Link, SearchParamError } from "@tanstack/react-router";
import type { JSX } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
import { RouteFailure } from "./route-failure";

export const TransactionsRouteFailure = ({ error }: ErrorComponentProps): JSX.Element =>
  error instanceof SearchParamError ? (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Transacciones</h1>
        <p className="text-muted-foreground">Revisa el periodo solicitado.</p>
      </header>
      <Alert variant="destructive">
        <AlertTitle>El enlace de transacciones no es válido</AlertTitle>
        <AlertDescription className="flex flex-col items-start gap-3">
          <span>Revisa el periodo del enlace o consulta el mes actual.</span>
          <Button render={<Link to="/app/transactions" search={{}} />}>Ir al mes actual</Button>
        </AlertDescription>
      </Alert>
    </main>
  ) : (
    <RouteFailure />
  );
