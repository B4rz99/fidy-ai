import type { Html } from "foldkit/html";
import type { ViewConfiguration, ViewContent } from "@/features/public-site/native/model";
import { fidyLogoUrl } from "@/ui/brand";

/** Keeps privacy, support and agent setup discoverable across marketing pages. */
export const Footer = (configuration: ViewConfiguration): ViewContent => {
  const html = configuration.html;
  return [html.footer([html.Class("footer")], [footerBrandViewPart(configuration)])];
};
const footerBrandViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  return html.div(
    [html.Class("wrap")],
    [
      html.div(
        [html.Class("footer-brand")],
        [
          html.a(
            [
              html.Class("logo"),
              html.Href("/"),
              html.Attribute("aria-label", String("Fidy, inicio")),
            ],
            [html.img([html.Src(fidyLogoUrl), html.Alt("fidy")])]
          ),
          html.p([], ["Finanzas personales para ti y tus agentes."]),
        ]
      ),
      html.nav(
        [html.Class("footer-links"), html.Attribute("aria-label", String("Información y ayuda"))],
        [
          html.a([html.Href("/politica")], ["Política de privacidad"]),
          html.a([html.Href("/cookies")], ["Cookies y almacenamiento"]),
          html.a([html.Href("/terminos")], ["Términos de servicio (borrador)"]),
          html.a([html.Href("mailto:obarboza@fidyapp.com")], ["Contacto y soporte"]),
          html.a([html.Href("/funciones/agentes#conectar")], ["Conecta tu agente"]),
        ]
      ),
    ]
  );
};
