import { currentDisclosureFacts } from "./current-disclosure";

const text = `Antes de crear tu cuenta, autoriza el tratamiento de tus datos personales para crear, autenticar, administrar y proteger tu cuenta, y registrar, organizar y presentar tus finanzas. Fidy procesa los datos y archivos que suministres. Los correos financieros originales se conservan hasta 90 días; una muestra estructural solo se conserva indefinidamente después de anonimización y aprobación humana. Tus datos pueden tratarse fuera de Colombia por los proveedores descritos en la política. Google autentica tu cuenta; no solicitamos acceso a tu correo. Puedes revocar tu autorización o pedir la supresión escribiendo a obarboza@fidyapp.com. La autorización dura mientras uses Fidy o hasta que la revoques, salvo plazos legales. Política completa: https://app.fidyapp.com/politica`;
export const webDisclosureFacts = {
  ...currentDisclosureFacts,
  revision: "web-google-2026-10-07",
  contentSha256: "94fa84577ebd2108accde2af2ac2c400ca6f1e1267f8a954bf6f74a50e59a2c0",
  text,
};
