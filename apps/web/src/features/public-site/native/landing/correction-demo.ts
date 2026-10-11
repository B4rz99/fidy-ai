import type { Html } from "foldkit/html";
import { Message } from "@/features/public-site/native/model";
import type { ViewConfiguration, ViewContent } from "@/features/public-site/native/model";

export const CorrectionDemo = (configuration: ViewConfiguration): ViewContent => {
  const html = configuration.html;
  const corrected = configuration.model.corrected;
  return [
    " ",
    html.div(
      [html.Class("detail-ledger")],
      [
        html.div(
          [html.Class("detail-app-title")],
          [html.b([], ["Transacciones"]), html.span([], ["Octubre · COP"])]
        ),
        html.div(
          [html.Class("detail-ledger-grid")],
          [
            detailTableHeadViewPart(configuration),
            ...CorrectionInspector({
              ...configuration,
              corrected,
              onCorrect: Message.Correct(),
            }),
          ]
        ),
      ]
    ),
    " ",
  ];
};
const CorrectionInspector = (
  configuration: ViewConfiguration & {
    corrected: boolean;
    onCorrect: Message;
  }
): ViewContent => [detailInspectorViewPart(configuration)];
const detailTableHeadViewPart = (configuration: ViewConfiguration): Html => {
  const html = configuration.html;
  const corrected = configuration.model.corrected;
  return html.div(
    [],
    [
      html.div(
        [html.Class("detail-table-head")],
        [html.span([], ["Transacción"]), html.span([], ["Fecha"]), html.span([], ["Valor"])]
      ),
      html.div(
        [html.Class("detail-table-row is-selected")],
        [
          html.span([], [html.b([], ["Crepes"]), html.small([], ["Restaurantes"])]),
          html.span([], ["04 oct"]),
          html.strong([], [corrected ? "− $26.000" : "− $28.000"]),
        ]
      ),
      html.div(
        [html.Class("detail-table-row ")],
        [
          html.span([], [html.b([], ["Mercado"]), html.small([], ["Mercado"])]),
          html.span([], ["03 oct"]),
          html.strong([], ["− $156.000"]),
        ]
      ),
      html.div(
        [html.Class("detail-table-row ")],
        [
          html.span([], [html.b([], ["Transporte"]), html.small([], ["Transporte"])]),
          html.span([], ["03 oct"]),
          html.strong([], ["− $12.000"]),
        ]
      ),
      html.div(
        [html.Class("detail-table-row ")],
        [
          html.span([], [html.b([], ["Café"]), html.small([], ["Restaurantes"])]),
          html.span([], ["02 oct"]),
          html.strong([], ["− $8.500"]),
        ]
      ),
    ]
  );
};
const detailInspectorViewPart = (
  configuration: ViewConfiguration & {
    corrected: boolean;
    onCorrect: Message;
  }
): Html => {
  const html = configuration.html;
  const { corrected, onCorrect } = configuration;
  return html.aside(
    [html.Class("detail-inspector")],
    [
      html.span([], ["Detalle de transacción"]),
      html.h3([], ["Crepes"]),
      html.dl(
        [],
        [
          html.dt([], ["Monto"]),
          html.dd(
            [html.DataAttribute("correction-amount", String(""))],
            [corrected ? "$26.000 COP" : "$28.000 COP"]
          ),
          html.dt([], ["Categoría"]),
          html.dd([], ["Restaurantes"]),
          html.dt([], ["Fecha"]),
          html.dd([], ["4 de octubre"]),
        ]
      ),
      html.button(
        [html.Class("btn"), html.DataAttribute("correct", String("")), html.OnClick(onCorrect)],
        [corrected ? "Reiniciar ejemplo" : "Probar una corrección"]
      ),
      html.output(
        [html.DataAttribute("correction-status", String(""))],
        [
          corrected
            ? "Monto corregido en este ejemplo. Es la misma transacción."
            : "Ejemplo: el monto correcto era $26.000.",
        ]
      ),
    ]
  );
};
