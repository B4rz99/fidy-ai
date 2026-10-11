import type { Html } from "foldkit/html";
import type { ViewConfiguration, ViewContent } from "../model";
import { PublicMetadata } from "@/features/public-site/native/metadata";
import { PublicPageLayout } from "@/features/public-site/native/page-layout";

/** Describes storage used by this release, without inferring provider tracking configuration. */
export const CookiesPolicy = (configuration: ViewConfiguration): ViewContent => {
  const html = configuration.html;
  return PublicPageLayout({
    ...configuration,
    layout: "document",
    children: [
      ...PublicMetadata({
        noIndex: false,
        ...configuration,
        title: "Cookies y almacenamiento — Fidy",
        path: "/cookies",
        description: "Qué guarda Fidy en tu navegador, para qué sirve y cómo controlarlo.",
      }),
      html.article(
        [html.Class("flex flex-col gap-5")],
        [
          html.h1(
            [html.Class("font-heading text-3xl font-semibold")],
            ["Cookies y almacenamiento"]
          ),
          html.p(
            [],
            [
              "Actualizada el 9 de octubre de 2026. Fidy usa almacenamiento necesario para iniciar sesión, mantenerla y gestionar el pago, y una preferencia visual opcional. Esta versión de la aplicación no incorpora cookies publicitarias ni herramientas de remarketing.",
            ]
          ),
          ...storage(configuration),
          flexViewPartPart(configuration),
        ]
      ),
    ],
  });
};
const storage = (configuration: ViewConfiguration): ViewContent => [
  flexViewPartPartPart(configuration),
];
const flexViewPartPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [html.Class("flex flex-col gap-2")],
    [
      html.h2([html.Class("font-heading text-xl font-semibold")], ["Tú tienes el control"]),
      html.p(
        [],
        [
          "Puedes borrar o bloquear cookies y almacenamiento desde la configuración del navegador. Bloquear la cookie de sesión impide usar las funciones autenticadas. Borrar datos de un pago pendiente puede impedir recuperar su estado: comprueba el resultado antes de intentar pagarlo otra vez.",
        ]
      ),
      html.p(
        [],
        [
          "Cerrar sesión elimina la cookie de Fidy; no revoca los permisos de tus agentes. El tema visual no es necesario para usar la página. Los servicios que abras por separado, como Google, Microsoft o Wompi, pueden usar tecnologías propias bajo sus políticas; la configuración de seguridad de Cloudflare también puede afectar el almacenamiento del navegador.",
        ]
      ),
      html.p(
        [],
        [
          "Para más información, consulta la",
          " ",
          html.a([html.Class("underline"), html.Href("/politica")], ["política de privacidad"]),
          " ",
          "o escribe a",
          " ",
          html.a(
            [html.Class("underline"), html.Href("mailto:obarboza@fidyapp.com")],
            ["obarboza@fidyapp.com"]
          ),
          ".",
        ]
      ),
    ]
  );
};
const flexViewPartPartPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.section(
    [html.Class("flex flex-col gap-4")],
    [
      html.h2([html.Class("font-heading text-xl font-semibold")], ["Qué guarda Fidy"]),
      html.div(
        [],
        [
          html.h3([html.Class("font-semibold")], ["Sesión · cookie necesaria"]),
          html.p(
            [],
            [
              html.code([], ["__Host-fidy_session"]),
              ", en ",
              html.code([], ["api.fidyapp.com"]),
              ", mantiene tu acceso autenticado. Contiene un identificador de sesión, no tus transacciones. Se envía por HTTPS y no puede leerla el JavaScript de la página. Dura hasta 30 días desde su emisión o renovación; cerrar sesión la elimina y revoca esa sesión.",
            ]
          ),
        ]
      ),
      fontSemiboldView(configuration),
      html.div(
        [],
        [
          html.h3([html.Class("font-semibold")], ["Apariencia · almacenamiento local opcional"]),
          html.p(
            [],
            [
              html.code([], ["fidy-landing-theme"]),
              " guarda el tema que eliges. No tiene un vencimiento automático; permanece hasta que cambies la preferencia o borres los datos del sitio.",
            ]
          ),
        ]
      ),
      html.div(
        [],
        [
          html.h3([html.Class("font-semibold")], ["Pago · almacenamiento temporal de la pestaña"]),
          html.p(
            [],
            [
              html.code([], ["fidy.payment-request.*"]),
              " conserva un identificador para recuperar el mismo intento de pago; ",
              html.code([], ["fidy.billing-email.*"]),
              ", el correo de facturación de ese intento. Se eliminan al alcanzar un resultado final o al terminar la sesión de la pestaña, según el navegador. No contienen números de tarjeta, códigos de seguridad ni códigos de un solo uso.",
            ]
          ),
        ]
      ),
    ]
  );
};
const fontSemiboldView = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [],
    [
      html.h3(
        [html.Class("font-semibold")],
        ["Inicio de sesión · cookies necesarias y temporales"]
      ),
      html.p(
        [],
        [
          html.code([], ["__Host-fidy_google"]),
          " y ",
          html.code([], ["__Host-fidy_microsoft"]),
          ", en",
          html.code([], [" api.fidyapp.com"]),
          ", vinculan el regreso de Google o Microsoft con el intento de autenticación iniciado en este navegador. Guardan una prueba temporal de seguridad, no tus transacciones. Son cookies de Fidy: se envían por HTTPS y el JavaScript de la página no puede leerlas. Caducan en 10 minutos y se eliminan al regresar del proveedor. Bloquearlas impide completar ese inicio de sesión.",
        ]
      ),
    ]
  );
};
