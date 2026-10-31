import type { JSX, ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "./alert";

export const TransactionPrivacyNotice = ({
  privacyLink,
}: Readonly<{ privacyLink: ReactNode }>): JSX.Element => (
  <div className="m-5">
    <Alert>
      <AlertTitle>Solo lectura</AlertTitle>
      <AlertDescription>
        Tu autorización está retirada. Puedes consultar tus transacciones guardadas sin reactivar el
        tratamiento. Esta consulta es gratuita. Para solicitar una corrección u otros datos,{" "}
        {privacyLink}.
      </AlertDescription>
    </Alert>
  </div>
);
