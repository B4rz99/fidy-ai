import { Config, Schema } from "effect";
import { DisclosureSnapshot } from "~/core/consent/model";
import { externalEndpoints } from "~/shell/_shared/external-endpoints";

/** Exact aviso de privacidad sent before Fidy creates a User. */
export const CURRENT_DISCLOSURE_TEXT = `Soy Fidy. Antes de crear tu cuenta necesito tu autorización previa, expresa e informada para tratar tus datos personales.

Política completa: https://fidyapp.com/politica

Para crear tu cuenta, responde exactamente “Acepto” o usa la opción Aceptar. Si no quieres crearla, responde “No acepto”.`;

/**
 * Current immutable disclosure facts at the configured public policy URL.
 * Callers may compare the revisions and digests as one versioned consent basis;
 * material copy changes require updating the corresponding revision and digest.
 */
export const currentDisclosure = Config.map(externalEndpoints, ({ policyUrl }) =>
  Schema.decodeUnknownSync(DisclosureSnapshot)({
    serviceMarket: "CO",
    locale: "es-CO",
    revision: "onboarding-2026-08-25",
    contentSha256: "e3d53b771ad54c0d05777aeefed717b8b93475aa35dcc52d381d8e1d629008c4",
    text: CURRENT_DISCLOSURE_TEXT,
    policy: {
      publicUrl: policyUrl,
      revision: "policy-2026-08-03",
      contentSha256: "4a1be9d2eaf9917e5f84dcaad53be4ad4f8f61b0f59253c212f322c161434d27",
    },
    purposes: [
      "Crear, autenticar, administrar y proteger la cuenta",
      "Registrar, organizar, consultar y presentar las finanzas personales",
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
  })
);
