import { Config, Schema } from "effect";
import { DisclosureSnapshot } from "~/core/consent/model";
import { externalEndpoints } from "~/shell/_shared/external-endpoints";

/** Source-controlled file served at the canonical public policy URL. */
export const CURRENT_POLICY_PATH = "public/politica.html";

/** Exact aviso de privacidad sent before Fidy creates a User. */
export const CURRENT_DISCLOSURE_TEXT = `Soy Fidy. Antes de crear tu cuenta necesito tu autorización previa, expresa e informada para tratar tus datos personales.

Política completa: https://fidyapp.com/politica

Para autorizar, responde exactamente “Acepto” o usa la opción Aceptar. Para continuar sin crear una cuenta, responde “No acepto”.`;

/**
 * Current immutable disclosure facts at the configured public policy URL.
 * Callers may compare the revisions and digests as one versioned consent basis;
 * material copy changes require updating the corresponding revision and digest.
 */
export const currentDisclosure = Config.map(externalEndpoints, ({ policyUrl }) =>
  Schema.decodeUnknownSync(DisclosureSnapshot)({
    serviceMarket: "CO",
    locale: "es-CO",
    revision: "onboarding-2026-08",
    contentSha256: "baeed2db4f3545103cef440d961dffd436679e0ac3dcfcddd6376847c283bb3b",
    text: CURRENT_DISCLOSURE_TEXT,
    policy: {
      publicUrl: policyUrl,
      revision: "policy-2026-08",
      contentSha256: "455b8d2608bf2506cee806f2174de47985b4b95dd58bf8ba4f4cc3ea6539d44e",
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
