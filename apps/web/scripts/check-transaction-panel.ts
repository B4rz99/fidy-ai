import assert from "node:assert/strict";
import { Config, Effect, Option } from "effect";

const { chromium } = await import("@playwright/test");

const css = Bun.fileURLToPath(new URL("../src/ui/components/transactions.css", import.meta.url));

const executable = await Effect.runPromise(Config.option(Config.String("ASSESSMENT_CHROMIUM")));

const browser = await chromium.launch({ executablePath: Option.getOrUndefined(executable) });

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
  await page.addStyleTag({ path: css });

  const reachable = (control: ReturnType<typeof page.getByRole>): Promise<boolean> =>
    control.evaluate((element) => {
      element.scrollIntoView({ block: "center", behavior: "instant" });
      const rect = element.getBoundingClientRect();

      return element.contains(
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      );
    });

  assert.ok(
    await reachable(page.getByRole("button", { name: "Guardar" })),
    "Save must be reachable in one scroll"
  );
  assert.ok(
    await reachable(page.getByRole("textbox")),
    "The user must be able to scroll back to Counterparty"
  );
} finally {
  await browser.close();
}
