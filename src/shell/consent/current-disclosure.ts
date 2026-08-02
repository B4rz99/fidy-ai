import { Config, Schema } from "effect";
import { DisclosureSnapshot } from "~/core/consent/model";
import { externalEndpoints } from "~/shell/_shared/external-endpoints";

/** Source-controlled file served at the canonical public policy URL. */
export const CURRENT_POLICY_PATH = "public/politica.html";

/** Exact aviso de privacidad sent before Fidy creates a User. */
export const CURRENT_DISCLOSURE_TEXT = `Soy Fidy. Antes de crear tu cuenta necesito tu autorización previa, expresa e informada para tratar tus datos personales.

Responsable: Fidy.

Datos: identidad y contacto (incluido tu número de teléfono), mensajes y archivos que envíes, datos financieros que registres y metadatos técnicos y de seguridad.

Finalidades: crear, autenticar, administrar y proteger tu cuenta; registrar, organizar, consultar y presentar tus finanzas personales; responder tus instrucciones y producir tableros, resúmenes e insights; entregar comunicaciones del servicio que autorices; prevenir abuso e incidentes; y cumplir obligaciones legales.

Conservación: mientras uses Fidy o hasta que revoques tu autorización, salvo los plazos legales aplicables. Puedes conocer, actualizar, rectificar o suprimir tus datos, pedir prueba de la autorización y revocarla escribiendo a privacidad@fidyapp.com.

Política completa: https://fidyapp.com/politica

Si autorizas este tratamiento, responde exactamente “Acepto” o usa la opción Aceptar. Un “sí” por sí solo no se considera aceptación. También puedes responder “No acepto”.`;

/**
 * Current immutable disclosure facts at the configured public policy URL.
 * Callers may compare the revisions and digests as one versioned consent basis;
 * material copy changes require updating the corresponding revision and digest.
 */
export const currentDisclosure = Config.map(externalEndpoints, ({ policyUrl }) =>
  Schema.decodeUnknownSync(DisclosureSnapshot)({
    serviceMarket: "CO",
    locale: "es-CO",
    revision: "onboarding-2026-01",
    contentSha256: "a100ee1569e107d4478be6e7bfa3e088a2d9449f23947646ef7615469b001f62",
    text: CURRENT_DISCLOSURE_TEXT,
    policy: {
      publicUrl: policyUrl,
      revision: "policy-2026-01",
      contentSha256: "d2ac2b3d872f65d9db3e2b4f08401fec5cfd441ebd0ac92a063cc4c643cf4b98",
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
    revocationMethod: "Solicitar la revocación o supresión escribiendo a privacidad@fidyapp.com.",
  })
);
