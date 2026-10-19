import type { Reporter, TestCase } from "@playwright/test/reporter";

/** Release the other browser fixture only after serial latency prerequisites have passed. */
export default class BrowserPhaseReporter implements Reporter {
  private released = false;

  onTestBegin(test: TestCase): void {
    if (!this.released && test.parent.project()?.name === "browser") {
      this.released = true;
      process.stdout.write("FIDY_BROWSER_LATENCY_VERIFIED\n");
    }
  }
}
