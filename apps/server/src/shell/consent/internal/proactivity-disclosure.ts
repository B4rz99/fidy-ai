import { Schema } from "effect";
import { DisclosureSnapshot } from "~/core/consent/contract";
import type { ProactivityOptInKind } from "~/shell/consent/contract";
import { currentDisclosureFacts } from "./current-disclosure";

const reminderText = `¿Quieres recibir gratis recordatorios de Fidy por WhatsApp para registrar tus movimientos? Por defecto se programan todos los días a las 18:00 en America/Bogota, incluso si ya registraste movimientos. Puedes cambiar la frecuencia o la hora. Si ignoras tres recordatorios entregados, preguntamos si quieres continuar; si ignoras dos más, pausamos los recordatorios.

Autorizas el uso de tu identidad de WhatsApp y de tus preferencias para enviar estos recordatorios mediante Kapso y Meta. Puedes rechazar sin afectar tu acceso a Fidy o revocar esta autorización cuando quieras. Esta autorización es independiente de los resúmenes semanales y las alertas de presupuesto. Política: https://app.fidyapp.com/politica

Elige únicamente la opción explícita de aceptar, rechazar o revocar correspondiente a esta solicitud. Ninguna otra respuesta concede autorización.`;
const budgetText = `¿Quieres recibir gratis alertas de presupuesto de Fidy por WhatsApp? Avisamos cuando las salidas registradas de la misma categoría y moneda alcanzan el 80% o el 100% de un presupuesto mensual. Cada umbral se avisa una vez al mes. No convertimos monedas ni enviamos alertas de umbrales anteriores a tu autorización. No es asesoría financiera.

Autorizas el uso de tus datos financieros registrados para generar y enviar estas alertas mediante Kapso y Meta. Puedes rechazar sin afectar tu acceso a Fidy o revocar esta autorización cuando quieras. Esta autorización es independiente de los resúmenes semanales y los recordatorios. Política: https://app.fidyapp.com/politica

Elige únicamente la opción explícita de aceptar, rechazar o revocar correspondiente a esta solicitud. Ninguna otra respuesta concede autorización.`;

const recurringText = `¿Quieres avisos gratis por WhatsApp de nuevos patrones históricos de cargos recurrentes? Agrupamos las confirmaciones elegibles del día y avisamos a las 09:00 del día siguiente, en la zona capturada. No indican cargos activos. Conservamos cada moneda. Excluimos confirmaciones suprimidas y días anteriores a tu autorización. Si la lista no cabe, enviamos la cantidad y un enlace al informe completo que requiere iniciar sesión.

Autorizas usar tus datos financieros registrados y tu identidad de WhatsApp para estos avisos mediante Kapso y Meta. Puedes rechazar o revocar cuando quieras sin afectar tu acceso a Fidy. Es independiente de presupuestos, recordatorios y resúmenes semanales. No es asesoría financiera. Política: https://app.fidyapp.com/politica

Solo la opción explícita Aceptar autoriza estos avisos.`;
const disclosures = {
  "manual-entry-reminder": {
    text: reminderText,
    hash: "b6b19d139d7cc400e40f6208aaad71329742a32dbe2523bb429378b0e179c8c1",
    purpose: "Enviar recordatorios gratuitos de registro manual por WhatsApp",
    categories: [
      "Preferencias de recordatorios",
      "Identidad de WhatsApp y evidencia de la decisión",
    ],
  },
  "budget-threshold": {
    text: budgetText,
    hash: "87b495d09eca025dfb72014867aae5832c2bc231cf38c2811893b7e93a2eade6",
    purpose: "Generar y enviar alertas gratuitas de presupuesto por WhatsApp",
    categories: [
      "Datos financieros registrados",
      "Identidad de WhatsApp y evidencia de la decisión",
    ],
  },
  "new-recurring-series": {
    text: recurringText,
    hash: "ac6afe8b8e588eff685d0eccad5d961f93c0ea81c7543574a7deefc6bb2d9e42",
    purpose:
      "Generar y enviar avisos gratuitos de patrones históricos de cargos recurrentes por WhatsApp",
    categories: [
      "Datos financieros registrados",
      "Identidad de WhatsApp y evidencia de la decisión",
    ],
  },
};
export const proactivityDisclosure = (kind: ProactivityOptInKind): DisclosureSnapshot =>
  Schema.decodeSync(DisclosureSnapshot)({
    ...currentDisclosureFacts,
    revision: `${kind}-whatsapp-2026-10-05`,
    contentSha256: disclosures[kind].hash,
    text: disclosures[kind].text,
    purposes: [disclosures[kind].purpose],
    dataCategories: disclosures[kind].categories,
    duration:
      "Hasta que revoques la autorización; la evidencia de la decisión se conserva para acreditar la autorización.",
    revocationMethod:
      "Elegir Revocar en una solicitud explícita de esta categoría o solicitarlo a obarboza@fidyapp.com.",
  });
