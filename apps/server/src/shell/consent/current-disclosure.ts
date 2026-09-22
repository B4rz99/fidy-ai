import { Config, Schema } from "effect";
import { DisclosureSnapshot } from "~/core/consent/model";

/** Exact aviso de privacidad sent before Fidy creates a User. */
export const CURRENT_DISCLOSURE_TEXT = `Soy Fidy. Antes de crear tu cuenta necesito tu autorización previa, expresa e informada para tratar tus datos personales.

Política completa: https://app.fidyapp.com/politica

Si activas el reenvío de correos financieros, Fidy procesa su texto, HTML e imágenes integradas para registrar movimientos. Conserva el correo original hasta 90 días. Una muestra estructural solo puede conservarse indefinidamente después de anonimización automática y aprobación humana.

Para crear tu cuenta, responde exactamente “Acepto” o usa la opción Aceptar. Si no quieres crearla, responde “No acepto”.`;

/**
 * Current immutable disclosure facts, including the exact policy URL named in the sent text.
 * Material copy changes require updating the corresponding revision and digest.
 */
export const currentDisclosureFor = (): DisclosureSnapshot =>
  Schema.decodeSync(DisclosureSnapshot)({
    serviceMarket: "CO",
    locale: "es-CO",
    revision: "onboarding-2026-09-22",
    contentSha256: "6bf9276d0ae4118ca597f056cf54c3cd7119cfd25304e570fe54bd4c23cad706",
    text: CURRENT_DISCLOSURE_TEXT,
    policy: {
      publicUrl: "https://app.fidyapp.com/politica",
      revision: "policy-2026-09-21",
      contentSha256: "71b8ccb17cdd31e7cef3a12105a10b8b701f7713781d72165698fb2c9eb57103",
    },
    purposes: [
      "Crear, autenticar, administrar y proteger la cuenta",
      "Registrar, organizar, consultar y presentar las finanzas personales",
      "Procesar correos financieros reenviados y conservar sus originales hasta 90 días",
      "Conservar indefinidamente muestras estructurales solo después de anonimización y aprobación humana",
      "Responder instrucciones y producir tableros, resúmenes e insights",
      "Entregar comunicaciones del servicio expresamente autorizadas",
      "Prevenir abuso e incidentes y cumplir obligaciones legales",
    ],
    dataCategories: [
      "Datos de identidad y contacto",
      "Mensajes, instrucciones y archivos",
      "Datos financieros suministrados por la persona usuaria",
      "Metadatos técnicos y de seguridad",
    ],
    duration:
      "Mientras la persona use Fidy o hasta que revoque su autorización, salvo los plazos legales aplicables.",
    revocationMethod: "Solicitar la revocación o supresión escribiendo a obarboza@fidyapp.com.",
  });

/** The same origin-qualified legal snapshot is used by the application and WhatsApp. */
export const currentDisclosure = Config.succeed(currentDisclosureFor());
