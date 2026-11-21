import { Link } from "@tanstack/react-router";
import type { JSX } from "react";
import { Button } from "@/ui/components/button";

export const RegisterTransactionAction = ({ card }: Readonly<{ card: string }>): JSX.Element => (
  <Button
    nativeButton={false}
    contentLayout="wrap"
    aria-label={`Registrar una transacción para ${card}`}
    render={<Link to="/app/transactions" search={{ capture: "manual" }} />}
  >
    Registrar una transacción
  </Button>
);
