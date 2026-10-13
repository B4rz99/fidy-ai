import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";
import { afterEach, beforeEach, vi } from "vitest";
import {
  installBrowserDefectListeners,
  makeBrowserDefectReporter,
  observeBrowserDecode,
} from "./browser-defects";

const diagnosticConsole = console;

describe("browser defect diagnostics", () => {
  beforeEach(() => {
    vi.spyOn(diagnosticConsole, "info").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("bounds page defect storms and tolerates a missing console sink", () => {
    const report = makeBrowserDefectReporter();
    for (let index = 0; index < 100; index++) report("render_uncaught");
    expect(diagnosticConsole.info).toHaveBeenCalledTimes(20);
    expect(diagnosticConsole.info).toHaveBeenLastCalledWith("fidy.browser.defect", {
      component: "browser",
      operation: "browser.defect",
      error: "render_uncaught",
    });
    vi.mocked(diagnosticConsole.info).mockImplementation(() => {
      throw new Error("sink unavailable");
    });
    expect(() => makeBrowserDefectReporter()("render_caught")).not.toThrow();
  });

  it("records global error categories without inspecting payloads and removes owned listeners", () => {
    const dispose = installBrowserDefectListeners(window);
    const sentinel = "private-error-stack-financial-value";
    window.dispatchEvent(
      new ErrorEvent("error", { message: sentinel, error: new Error(sentinel) })
    );
    window.dispatchEvent(new Event("unhandledrejection"));
    expect(diagnosticConsole.info).toHaveBeenCalledTimes(2);
    expect(
      Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(
        vi.mocked(diagnosticConsole.info).mock.calls
      )
    ).not.toContain(sentinel);
    expect(diagnosticConsole.info).toHaveBeenLastCalledWith("fidy.browser.defect", {
      component: "browser",
      operation: "browser.defect",
      error: "unhandled_rejection",
    });
    dispose();
    window.dispatchEvent(new ErrorEvent("error", { message: sentinel }));
    expect(diagnosticConsole.info).toHaveBeenCalledTimes(2);
  });

  it.effect("reports schema rejection without schema input and preserves the exact failure", () =>
    Effect.gen(function* () {
      const sentinel = "private-schema-response";
      const response = Schema.decodeUnknownEffect(
        Schema.Struct({ status: Schema.Literal("ready") })
      )({ status: sentinel });
      const expected = yield* Effect.exit(response);
      expect(Exit.isFailure(expected)).toBe(true);
      if (!Exit.isFailure(expected)) return;
      const observed = yield* Effect.exit(observeBrowserDecode(Effect.failCause(expected.cause)));
      expect(Exit.isFailure(observed)).toBe(true);
      if (!Exit.isFailure(observed)) return;
      const originalError = Cause.findErrorOption(expected.cause);
      const observedError = Cause.findErrorOption(observed.cause);
      expect(originalError._tag).toBe("Some");
      expect(observedError._tag).toBe("Some");
      if (originalError._tag !== "Some" || observedError._tag !== "Some") return;
      expect(observedError.value).toBe(originalError.value);
      expect(diagnosticConsole.info).toHaveBeenCalledExactlyOnceWith("fidy.browser.defect", {
        component: "browser",
        operation: "browser.defect",
        error: "invalid_response",
      });
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          vi.mocked(diagnosticConsole.info).mock.calls
        )
      ).not.toContain(sentinel);
    })
  );

  it.effect(
    "observes client defects while leaving declared failures and cancellation untouched",
    () =>
      Effect.gen(function* () {
        const sentinel = "private-unexpected-defect";
        const observed = yield* Effect.exit(observeBrowserDecode(Effect.die(sentinel)));
        expect(observed).toEqual(Exit.die(sentinel));
        expect(diagnosticConsole.info).toHaveBeenCalledExactlyOnceWith("fidy.browser.defect", {
          component: "browser",
          operation: "browser.defect",
          error: "client_defect",
        });
        yield* Effect.exit(observeBrowserDecode(Effect.fail({ error: { code: "forbidden" } })));
        yield* Effect.exit(observeBrowserDecode(Effect.failCause(Cause.interrupt(1))));
        yield* observeBrowserDecode(Effect.succeed("ready"));
        expect(diagnosticConsole.info).toHaveBeenCalledTimes(1);
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            vi.mocked(diagnosticConsole.info).mock.calls
          )
        ).not.toContain(sentinel);
      })
  );
});
