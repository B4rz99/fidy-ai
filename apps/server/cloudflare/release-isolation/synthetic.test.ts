import { expect, it } from "vitest";
import { Clock, Effect, Option } from "effect";
import {
  acceptanceRequestAdmitted,
  acceptanceSubject,
  closedHostEnvironment,
  releaseAdmission,
  signAcceptanceRequest,
} from "./operations";

it("admits only the signed HTTP boundary, original credentials, body, origin and short-lived release", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const env = {
        SMOKE_PROOF: "a".repeat(48),
        RELEASE_GIT_SHA: "2".repeat(40),
        BROWSER_ORIGIN: "https://storage-web-acceptance.fidyapp.com",
        NATIVE_STORAGE_ADMISSION: "closed",
        RECOVERY_ISOLATION: "isolated",
      };

      const url = "https://storage-acceptance.fidyapp.com/transactions",
        now = 1_800_000_000_000;

      const request = (params: RequestInit = {}): Request =>
        new Request(url, {
          method: "POST",
          body: "one",
          headers: { authorization: "Bearer owned" },
          ...params,
        });

      const signed = yield* signAcceptanceRequest({
        request: request(),
        environment: env,
        boundary: "ingress",
        deadline: now + 30000,
      });

      const headers = new Headers({
        authorization: "Bearer owned",
        "x-fidy-acceptance-proof": signed,
      });

      const admitted = (
        req: Request,
        time: number,
        boundary: "ingress" | "core" = "ingress"
      ): Effect.Effect<boolean> =>
        acceptanceRequestAdmitted({ request: req, environment: env, now: time, boundary });

      expect(yield* admitted(request({ headers }), now)).toBe(true);
      expect(yield* admitted(request(), now)).toBe(false);
      expect(yield* admitted(request({ headers, body: "changed" }), now)).toBe(false);
      expect(yield* admitted(request({ headers }), now, "core")).toBe(false);
      expect(yield* admitted(request({ headers }), now + 30001)).toBe(false);
      expect(
        yield* admitted(
          new Request("https://api.fidyapp.com/transactions", request({ headers })),
          now
        )
      ).toBe(false);
      headers.set("authorization", "Bearer other");
      expect(yield* admitted(request({ headers }), now)).toBe(false);
    })
  ));

it("keeps ordinary admission on the canonical API and bounds each predeclared synthetic cohort to its original issuer and release", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const revision = "2".repeat(40),
        canonical = "https://api.fidyapp.com",
        acceptance = "https://storage-acceptance.fidyapp.com";

      const settings = {
        RELEASE_GIT_SHA: revision,
        BROWSER_ORIGIN: "https://app.fidyapp.com",
        SQLITE_STORAGE_RELEASE: "native",
        NATIVE_STORAGE_ADMISSION: "open",
        RECOVERY_ISOLATION: "",
      };

      const check = (origin: string, admission: string): Effect.Effect<boolean> =>
        releaseAdmission(
          new Request(origin + "/transactions"),
          { ...settings, NATIVE_STORAGE_ADMISSION: admission },
          "ingress"
        ).pipe(Effect.map((value) => Option.isNone(value.denial)));

      expect(yield* check(canonical, "open")).toBe(true);
      expect(yield* check(acceptance, "open")).toBe(false);
      expect(yield* check(canonical, "misspelled")).toBe(false);

      for (const [purpose, limit] of [
        ["smoke", 2],
        ["erasure", 1],
        ["performance", 20],
        ["fleet", 1000],
      ] as const) {
        const subject = `fidy-acceptance-${revision}-${purpose}-`;

        const admitted = (ordinal: number, issuer: string): boolean =>
          acceptanceSubject({ subject: subject + ordinal, revision, issuer });

        expect(admitted(limit, "https://accounts.google.com")).toBe(true);
        expect(admitted(limit + 1, "https://accounts.google.com")).toBe(false);
        expect(admitted(limit, "https://other.example")).toBe(false);
      }
    })
  ));

it("binds each closed Core request to the browser and provider callbacks selected by its exact TLS host", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const env = {
        NATIVE_STORAGE_ADMISSION: "closed",
        RECOVERY_ISOLATION: "isolated",
        SMOKE_PROOF: "a".repeat(48),
        RELEASE_GIT_SHA: "2".repeat(40),
        BROWSER_ORIGIN: "https://storage-web-acceptance.fidyapp.com",
        GOOGLE_REDIRECT_URI: "",
        MICROSOFT_REDIRECT_URI: "",
      };

      const now = 1_800_000_000_000;

      yield* Effect.forEach(
        [
          ["https://api.fidyapp.com", "https://app.fidyapp.com"],
          ["https://storage-acceptance.fidyapp.com", "https://storage-web-acceptance.fidyapp.com"],
        ] as const,
        Effect.fnUntraced(function* ([api, browser]) {
          const ingress = closedHostEnvironment({
            request: new Request(api + "/transactions", {
              headers: { "x-fidy-acceptance-api": "https://unknown.invalid" },
            }),
            environment: env,
            boundary: "ingress",
          });

          expect([
            ingress.BROWSER_ORIGIN,
            ingress.GOOGLE_REDIRECT_URI,
            ingress.MICROSOFT_REDIRECT_URI,
          ]).toEqual([
            browser,
            api + "/providers/google/callback",
            api + "/providers/microsoft/callback",
          ]);

          const request = new Request("https://core.internal/transactions", {
            headers: { "x-fidy-acceptance-api": api },
          });

          const core = closedHostEnvironment({ request, environment: env, boundary: "core" });

          const proof = yield* signAcceptanceRequest({
            request,
            boundary: "core",
            environment: ingress,
            deadline: now + 30000,
          });

          request.headers.set("x-fidy-acceptance-proof", proof);
          expect(
            yield* acceptanceRequestAdmitted({ request, boundary: "core", environment: core, now })
          ).toBe(true);
          request.headers.set("x-fidy-acceptance-api", "https://unknown.invalid");
          expect(
            yield* acceptanceRequestAdmitted({ request, boundary: "core", environment: core, now })
          ).toBe(false);
        }),
        { discard: true }
      );
    })
  ));

it("hands Core a replayable request with the identical authenticated bytes from a streamed POST", () => {
  const abort = new AbortController();

  return Effect.runPromise(
    Effect.gen(function* () {
      const environment = {
        SMOKE_PROOF: "a".repeat(48),
        RELEASE_GIT_SHA: "2".repeat(40),
        BROWSER_ORIGIN: "https://storage-web-acceptance.fidyapp.com",
        NATIVE_STORAGE_ADMISSION: "closed",
        RECOVERY_ISOLATION: "isolated",
      };

      const url = "https://core.internal/web/pairings";
      const bytes = new TextEncoder().encode('{ "memo": "café" }');

      const headers = new Headers({
        "content-type": "application/json",
        origin: environment.BROWSER_ORIGIN,
      });

      const deadline = (yield* Clock.currentTimeMillis) + 30_000;
      headers.set(
        "x-fidy-acceptance-proof",
        yield* signAcceptanceRequest({
          environment,
          boundary: "core",
          deadline,
          request: new Request(url, { method: "POST", headers, body: bytes }),
        })
      );

      const incoming = new Request(url, {
        method: "POST",
        headers,
        signal: abort.signal,
        duplex: "half",
        body: new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(bytes.subarray(0, 3));
            controller.enqueue(bytes.subarray(3));
            controller.close();
          },
        }),
      });

      const admission = yield* releaseAdmission(incoming, environment, "core");
      expect(Option.isNone(admission.denial)).toBe(true);
      expect(incoming.bodyUsed).toBe(true);
      expect(admission.request.headers.get("x-fidy-acceptance-proof")).toBe(
        headers.get("x-fidy-acceptance-proof")
      );
      expect(admission.request.headers.get("origin")).toBe(environment.BROWSER_ORIGIN);
      expect(admission.request.url).toBe(url);
      expect(admission.request.method).toBe("POST");
      expect(
        new Uint8Array(yield* Effect.tryPromise(() => admission.request.arrayBuffer()))
      ).toEqual(bytes);
      abort.abort();
      expect(admission.request.signal.aborted).toBe(true);
    })
  );
});
