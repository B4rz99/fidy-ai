// A tall Correction must remain reachable alongside a longer desktop Transaction history.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const css = await readFile(
  new URL("../../../apps/web/src/ui/components/transactions.css", import.meta.url),
  "utf8"
);
const browser = await chromium.launch({ executablePath: process.env.ASSESSMENT_CHROMIUM });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent(`
    <style>
      * { box-sizing: border-box; }
      #rows { height: 300vh; }
      fieldset { height: 120vh; }
    </style>
    <main data-transaction-slot="transaction-workspace" data-panel-open="true">
      <h1>Transacciones</h1>
      <div data-transaction-slot="transaction-columns">
        <div id="rows" data-transaction-slot="transaction-records">Historial</div>
        <dialog open data-transaction-slot="transaction-context-panel">
          <form aria-label="Corregir transacción">
            <fieldset><input aria-label="Contraparte"></fieldset>
            <div data-transaction-slot="transaction-form-actions"><button>Guardar</button></div>
          </form>
        </dialog>
      </div>
    </main>`);
  await page.addStyleTag({ content: css });
  for (const control of [
    page.getByRole("button", { name: "Guardar" }),
    page.getByRole("textbox"),
  ]) {
    const reachable = await control.evaluate((element) => {
      element.scrollIntoView({ block: "center", behavior: "instant" });
      const rect = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      );
    });
    assert.ok(reachable, "The Correction control must be reachable in one scroll");
  }
} finally {
  await browser.close();
}
