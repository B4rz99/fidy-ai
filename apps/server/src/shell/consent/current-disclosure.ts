import { Config, Schema } from "effect";
import { DisclosureSnapshot } from "~/core/consent/model";

/** Exact aviso de privacidad sent before Fidy creates a User. */
export const CURRENT_DISCLOSURE_TEXT = `Soy Fidy. Antes de crear tu cuenta necesito tu autorización previa, expresa e informada para tratar tus datos personales.

Política completa: https://app.fidyapp.com/politica

Usamos Kapso y Meta para atenderte por WhatsApp. Si envías una nota de voz, Kapso puede convertirla en texto con ayuda de otras empresas. Tus datos pueden tratarse fuera de Colombia. Consulta en la política cuánto tiempo pueden conservarse y cómo pedir su eliminación.

Si activas el reenvío de correos financieros, Fidy procesa su texto, HTML e imágenes integradas para registrar movimientos. Conserva el correo original hasta 90 días. Una muestra estructural solo puede conservarse indefinidamente después de anonimización automática y aprobación humana.

Para crear tu cuenta, responde exactamente “Acepto” o usa la opción Aceptar. Si no quieres crearla, responde “No acepto”. Después de aceptar, responde con tu correo electrónico para recibir un código de verificación. Puedes escribir “Estado” para consultar el envío.`;

/**
 * Current immutable disclosure facts, including the exact policy URL named in the sent text.
 * Material copy changes require updating the corresponding revision and digest.
 */
export const currentDisclosureFor = (): DisclosureSnapshot =>
  Schema.decodeSync(DisclosureSnapshot)({
    serviceMarket: "CO",
    locale: "es-CO",
    revision: "onboarding-2026-09-28-kapso",
    contentSha256: "1dab7152fe6b87ab035a3c7a91c679a357a89eda2909ea7c3cb588913aaf1b47",
    text: CURRENT_DISCLOSURE_TEXT,
    policy: {
      publicUrl: "https://app.fidyapp.com/politica",
      revision: "policy-2026-09-28-kapso",
      contentSha256: "dd6192d91817affa541eeec914ad1b9be836d2690a2dc15c003bab79727e3536",
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
