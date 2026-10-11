import type { Html } from "foldkit/html";
import type { ViewConfiguration, ViewContent } from "@/features/public-site/native/model";
import { PublicMetadata } from "@/features/public-site/native/metadata";
import { PublicPageLayout } from "@/features/public-site/native/page-layout";

/** Presents a review draft, not an active agreement or a change to recorded consent. */
export const Terms = (configuration: ViewConfiguration): ViewContent => {
  const html = configuration.html;
  return PublicPageLayout({
    ...configuration,
    layout: "document",
    children: [
      ...PublicMetadata({
        ...configuration,
        title: "Términos de servicio — Fidy",
        path: "/terminos",
        noIndex: true,
        description: "Propuesta breve de condiciones de uso de Fidy para Colombia.",
      }),
      html.article(
        [html.Class("flex flex-col gap-5")],
        [
          html.h1(
            [html.Class("font-heading text-3xl font-semibold")],
            ["Términos de servicio de Fidy"]
          ),
          html.p(
            [html.Class("rounded-xl border p-4")],
            [
              html.strong([], ["Borrador para revisión · 9 de octubre de 2026."]),
              " No está vigente. Antes de publicarlo deben completarse el nombre o razón social del prestador, NIT, dirección de notificaciones, teléfono y fecha de vigencia.",
            ]
          ),
          ...service(configuration),
          ...account(configuration),
          ...payment(configuration),
          ...rights(configuration),
          ...closing(configuration),
        ]
      ),
    ],
  });
};
const service = (configuration: ViewConfiguration): ViewContent => {
  const html = configuration.html;
  return [
    html.section(
      [html.Class("flex flex-col gap-2")],
      [
        html.h2([html.Class("font-heading text-xl font-semibold")], ["1. Para qué sirve Fidy"]),
        html.p(
          [],
          [
            "Fidy te ayuda a registrar, organizar y consultar tus finanzas personales desde la web, WhatsApp y tus agentes autorizados. Por ahora se ofrece en Colombia. No es un banco, no custodia tu dinero ni ejecuta transferencias o inversiones por ti. Sus respuestas pueden contener errores y dependen de los datos disponibles: revísalas antes de tomar decisiones. No reemplazan asesoría financiera, contable o tributaria profesional.",
          ]
        ),
      ]
    ),
  ];
};
const account = (configuration: ViewConfiguration): ViewContent => [flexViewPart(configuration)];
const payment = (configuration: ViewConfiguration): ViewContent => {
  const html = configuration.html;
  return [
    html.section(
      [html.Class("flex flex-col gap-2")],
      [
        html.h2(
          [html.Class("font-heading text-xl font-semibold")],
          ["3. Prueba, pagos y cancelación"]
        ),
        html.p(
          [],
          [
            "Al crear tu cuenta recibes una única prueba Pro de 7 días, sin tarjeta. La prueba no activa una suscripción de pago. Antes de pagar verás el precio total en COP, el período, el medio de pago y las condiciones de renovación. Solo se cobra lo que autorices; Wompi procesa el pago.",
          ]
        ),
        html.p(
          [],
          [
            "Puedes cancelar futuras renovaciones desde la suscripción y conservar el acceso durante el período pagado. Dejar de usar Fidy no cancela por sí solo una renovación autorizada. Cancelar no elimina tus derechos legales de devolución.",
          ]
        ),
      ]
    ),
  ];
};
const rights = (configuration: ViewConfiguration): ViewContent => [flexViewPartPart(configuration)];
const closing = (configuration: ViewConfiguration): ViewContent => {
  const html = configuration.html;
  return [
    html.section(
      [html.Class("flex flex-col gap-2")],
      [
        html.h2(
          [html.Class("font-heading text-xl font-semibold")],
          ["5. Disponibilidad y cambios"]
        ),
        html.p(
          [],
          [
            "Fidy puede requerir mantenimiento y medidas proporcionales frente a fraude o riesgos de seguridad. Informaremos cambios relevantes del servicio o de estas condiciones antes de aplicarlos y solicitaremos aceptación cuando corresponda. No reduciremos tus derechos legales ni modificaremos retroactivamente condiciones ya pagadas. Se aplica la legislación colombiana.",
          ]
        ),
      ]
    ),
  ];
};
const flexViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [html.Class("flex flex-col gap-2")],
    [
      html.h2(
        [html.Class("font-heading text-xl font-semibold")],
        ["2. Tu cuenta, tus datos y tus agentes"]
      ),
      html.p(
        [],
        [
          "Usa información que tengas derecho a compartir, protege tu acceso y no uses Fidy para fraude, acceso ajeno o interferir con el servicio. No envíes claves bancarias, contraseñas ni números de tarjeta al chat. Conservas los derechos sobre tus datos; su tratamiento se rige por la",
          " ",
          html.a([html.Class("underline"), html.Href("/politica")], ["política de privacidad"]),
          " ",
          "y tu autorización.",
        ]
      ),
      html.p(
        [],
        [
          "Elige los permisos y la vigencia de tus agentes. Puedes revocarlos desde Fidy; cerrar sesión no los revoca y revocarlos no deshace cambios ya completados. Los servicios externos también tienen sus propias condiciones.",
        ]
      ),
    ]
  );
};
const flexViewPartPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [html.Class("flex flex-col gap-2")],
    [
      html.h2(
        [html.Class("font-heading text-xl font-semibold")],
        ["4. Ayuda y derechos del consumidor"]
      ),
      html.p(
        [],
        [
          "Para soporte, reclamaciones, cierre de cuenta o solicitudes sobre tus datos, escribe a",
          " ",
          html.a(
            [html.Class("underline"), html.Href("mailto:obarboza@fidyapp.com")],
            ["obarboza@fidyapp.com"]
          ),
          ". No incluyas contraseñas ni datos completos de pago.",
        ]
      ),
      html.p(
        [],
        [
          "Cuando aplique el retracto, puedes solicitarlo dentro de los 5 días hábiles siguientes a la contratación. La ley prevé excepciones, como servicios cuya ejecución comenzó con tu acuerdo. Si procede en comercio electrónico, la devolución se realiza dentro del plazo legal de 15 días calendario una vez cumplidos sus requisitos. Para una reversión de pago que corresponda, presenta la reclamación a Fidy y al emisor del medio de pago dentro del plazo legal aplicable.",
        ]
      ),
      html.p(
        [],
        [
          "Estos términos no excluyen garantías, responsabilidad legal ni derechos irrenunciables. Puedes acudir a la",
          " ",
          html.a(
            [html.Class("underline"), html.Href("https://www.sic.gov.co/")],
            ["Superintendencia de Industria y Comercio"]
          ),
          " ",
          "o a la autoridad competente.",
        ]
      ),
    ]
  );
};
