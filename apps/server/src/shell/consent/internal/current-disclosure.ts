import type { DisclosureSnapshot } from "~/core/consent/contract";

/** Exact aviso de privacidad sent before Fidy creates a User. */
const CURRENT_DISCLOSURE_TEXT = `Soy Fidy. Antes de crear tu cuenta necesito tu autorización previa, expresa e informada para tratar tus datos personales.

Política completa: https://app.fidyapp.com/politica

Usamos Kapso y Meta para atenderte por WhatsApp. Si envías una nota de voz, Kapso puede convertirla en texto con ayuda de otras empresas. Tus datos pueden tratarse fuera de Colombia. En el plan gratuito, Kapso guarda el historial de WhatsApp sin borrarlo automáticamente. Consulta en la política cómo pedir su eliminación.

Si activas el reenvío de correos financieros, Fidy procesa su texto, HTML e imágenes integradas para registrar movimientos. Conserva el correo original hasta 90 días. Una muestra estructural solo puede conservarse indefinidamente después de anonimización automática y aprobación humana.

Para crear tu cuenta, responde exactamente “Acepto” o usa la opción Aceptar. Si no quieres crearla, responde “No acepto”. Después de aceptar, abre el enlace de Fidy para autenticarte con Google o Microsoft. Vuelve a este chat y escribe “Estado” para revisar y confirmar la asociación de tu cuenta con este chat. No compartas credenciales ni códigos de recuperación por WhatsApp.`;

/** Source-controlled disclosure facts; revisions and digests pin these exact legal bytes. */
export const currentDisclosureFacts: typeof DisclosureSnapshot.Encoded = {
  serviceMarket: "CO",
  locale: "es-CO",
  revision: "onboarding-2026-10-08-providers",
  contentSha256: "034da77df22d383b92d155827c96d823aaaaf5b31fcd96f1dfe8328a4e4ef9b8",
  text: CURRENT_DISCLOSURE_TEXT,
  policy: {
    publicUrl: "https://app.fidyapp.com/politica",
    revision: "policy-2026-10-09-browser-agents",
    contentSha256: "215218d7bf6860ae8ee7d7785f5d6f03a9b8135bd163f91d9da369dca118d049",
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
};
