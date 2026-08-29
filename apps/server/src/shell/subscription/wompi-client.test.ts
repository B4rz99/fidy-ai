import { BunServices } from "@effect/platform-bun";
import { expect, it, layer } from "@effect/vitest";
import {
  type Config,
  ConfigProvider,
  DateTime,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Redacted,
} from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { BillingEmail, WompiSourceId } from "~/core/subscription/enrollment-model";
import {
  WompiEnrollmentClient,
  WompiSourceCreationFailed,
  WompiSourceLookupFailed,
} from "./wompi-client";

const exampleKey = (visibility: "pub" | "prv", environment: "prod" | "test"): string =>
  [visibility, environment, "examplekey"].join("_");
const sandboxPublicKey = exampleKey("pub", "test");
const sandboxPrivateKey = exampleKey("prv", "test");
const productionPublicKey = exampleKey("pub", "prod");
const productionPrivateKey = exampleKey("prv", "prod");

const config = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    WOMPI_ENVIRONMENT: "sandbox",
    WOMPI_PUBLIC_KEY: sandboxPublicKey,
    WOMPI_PRIVATE_KEY: sandboxPrivateKey,
  })
);
const productionConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    WOMPI_ENVIRONMENT: "production",
    WOMPI_PUBLIC_KEY: productionPublicKey,
    WOMPI_PRIVATE_KEY: productionPrivateKey,
  })
);
const mismatchedPublicConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    WOMPI_ENVIRONMENT: "production",
    WOMPI_PUBLIC_KEY: sandboxPublicKey,
    WOMPI_PRIVATE_KEY: productionPrivateKey,
  })
);
const mismatchedPrivateConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    WOMPI_ENVIRONMENT: "sandbox",
    WOMPI_PUBLIC_KEY: sandboxPublicKey,
    WOMPI_PRIVATE_KEY: productionPrivateKey,
  })
);
const invalidPrivateConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    WOMPI_ENVIRONMENT: "sandbox",
    WOMPI_PUBLIC_KEY: sandboxPublicKey,
    WOMPI_PRIVATE_KEY: "invalid",
  })
);
const sha256HexCharacters = 64;
const transientCardToken = "tok_test_browser_only";
const endUserAcceptanceToken =
  "header.eyJwZXJtYWxpbmsiOiJodHRwczovL3dvbXBpLmV4YW1wbGUvZW5kLXVzZXIucGRmIiwiZmlsZV9oYXNoIjoiMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMiJ9.signature";
const personalDataAcceptanceToken =
  "header.eyJwZXJtYWxpbmsiOiJodHRwczovL3dvbXBpLmV4YW1wbGUvcGVyc29uYWwtZGF0YS5wZGYiLCJmaWxlX2hhc2giOiIzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzIn0.signature";
const merchantBody = `{
  "data": {
    "presigned_acceptance": {
      "acceptance_token": "${endUserAcceptanceToken}",
      "permalink": "https://wompi.example/end-user.pdf"
    },
    "presigned_personal_data_auth": {
      "acceptance_token": "${personalDataAcceptanceToken}",
      "permalink": "https://wompi.example/personal-data.pdf"
    }
  }
}`;

const clientLayerWithConfig = (
  sourceResponse: Response,
  merchantResponse: Response,
  configLayer: Layer.Layer<never, Config.ConfigError>
): Layer.Layer<WompiEnrollmentClient, Config.ConfigError> => {
  const client = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        request.url.includes("/v1/merchants/") ? merchantResponse : sourceResponse
      )
    )
  );
  return WompiEnrollmentClient.layer.pipe(
    Layer.provide(Layer.merge(Layer.succeed(HttpClient.HttpClient, client), configLayer)),
    Layer.provide(BunServices.layer)
  );
};

const clientLayer = (
  sourceResponse: Response
): Layer.Layer<WompiEnrollmentClient, Config.ConfigError> =>
  clientLayerWithConfig(sourceResponse, new Response(merchantBody, { status: 200 }), config);

const loadContracts = Effect.gen(function* () {
  const wompi = yield* WompiEnrollmentClient;
  return yield* wompi.contracts(DateTime.makeUnsafe("2026-04-01T00:00:00.000Z"));
});

const verifyPaymentSource = Effect.gen(function* () {
  const wompi = yield* WompiEnrollmentClient;
  return yield* wompi.verifyPaymentSource(WompiSourceId.make(3891));
});

const createPaymentSource = Effect.gen(function* () {
  const wompi = yield* WompiEnrollmentClient;
  const contracts = yield* wompi.contracts(DateTime.makeUnsafe("2026-04-01T00:00:00.000Z"));
  return yield* wompi.createPaymentSource({
    cardToken: Redacted.make(transientCardToken),
    billingEmail: BillingEmail.make("payer@example.com"),
    contracts,
  });
});

layer(clientLayer(new Response('{"data":{"id":3891,"status":"AVAILABLE"}}', { status: 201 })), {
  excludeTestServices: true,
})("Wompi available source adapter", (it) => {
  it.effect("derives safe contract evidence and creates one available source", () =>
    Effect.gen(function* () {
      expect(yield* createPaymentSource).toEqual({ _tag: "Available", sourceId: 3891 });
    })
  );
});

layer(
  clientLayer(
    new Response('{"data":{"id":3891,"status":"AVAILABLE","customer_email":"payer@example.com"}}', {
      status: 200,
    })
  ),
  { excludeTestServices: true }
)("Wompi source verification adapter", (it) => {
  it.effect("authenticates and projects an available source", () =>
    Effect.gen(function* () {
      expect(yield* verifyPaymentSource).toEqual({
        sourceId: 3891,
        billingEmail: "payer@example.com",
      });
    })
  );
});

for (const [label, response] of [
  ["provider refusal", new Response("not found", { status: 404 })],
  ["malformed provider projection", new Response('{"data":{"id":3891}}', { status: 200 })],
] as const) {
  layer(clientLayer(response), { excludeTestServices: true })(
    `Wompi source verification ${label}`,
    (it) => {
      it.effect("fails closed without exposing the response", () =>
        Effect.gen(function* () {
          expect((yield* Effect.flip(verifyPaymentSource))._tag).toBe("WompiSourceLookupFailed");
        })
      );
    }
  );
}

layer(clientLayer(new Response("unused")), { excludeTestServices: true })(
  "Wompi provider contract revision evidence",
  (it) => {
    it.effect("retains provider content hashes from the acceptance claims", () =>
      Effect.gen(function* () {
        const contracts = yield* loadContracts;
        expect(contracts.evidence.endUserPolicy.providerContentHash).toBe(
          "2".repeat(sha256HexCharacters)
        );
        expect(contracts.evidence.personalDataAuthorization.providerContentHash).toBe(
          "3".repeat(sha256HexCharacters)
        );
      })
    );
  }
);

for (const [label, acceptanceToken] of [
  ["missing claims segment", "invalid"],
  ["invalid claims encoding", "header.%.signature"],
  ["malformed claims", "header.e30.signature"],
  ["mismatched claims permalink", personalDataAcceptanceToken],
] as const) {
  layer(
    clientLayerWithConfig(
      new Response("unused"),
      new Response(merchantBody.replace(endUserAcceptanceToken, acceptanceToken), { status: 200 }),
      config
    ),
    { excludeTestServices: true }
  )(`Wompi acceptance ${label}`, (it) => {
    it.effect("fails closed before presenting provider terms", () =>
      Effect.gen(function* () {
        expect((yield* Effect.flip(loadContracts))._tag).toBe("WompiContractsUnavailable");
      })
    );
  });
}

layer(clientLayer(new Response("declined secret", { status: 422 })), {
  excludeTestServices: true,
})("Wompi definitive refusal adapter", (it) => {
  it.effect("keeps provider credentials, card tokens, and response bodies out of failures", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(createPaymentSource);
      expect(failure).toEqual(new WompiSourceCreationFailed({ certainty: "rejected" }));
    })
  );
});

layer(clientLayer(new Response("source lookup secret", { status: 404 })), {
  excludeTestServices: true,
})("Wompi source lookup credential boundary", (it) => {
  it.effect("keeps reconciliation source IDs out of lookup failures", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(verifyPaymentSource);
      expect(failure).toEqual(new WompiSourceLookupFailed());
    })
  );
});

layer(clientLayer(new Response(null, { status: 101 })), {
  excludeTestServices: true,
})("Wompi premature source adapter", (it) => {
  it.effect("treats a source response below the successful range as definitive", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(createPaymentSource);
      expect(failure).toEqual(new WompiSourceCreationFailed({ certainty: "rejected" }));
    })
  );
});

layer(clientLayer(new Response("redirect body", { status: 300 })), {
  excludeTestServices: true,
})("Wompi non-success redirect adapter", (it) => {
  it.effect("treats a non-success status below provider outages as definitive", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(createPaymentSource);
      expect(failure).toEqual(new WompiSourceCreationFailed({ certainty: "rejected" }));
    })
  );
});

layer(clientLayer(new Response("not-json", { status: 201 })), {
  excludeTestServices: true,
})("Wompi invalid JSON source adapter", (it) => {
  it.effect("fences a non-JSON success body as ambiguous", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(createPaymentSource);
      expect(failure).toEqual(new WompiSourceCreationFailed({ certainty: "ambiguous" }));
    })
  );
});

layer(clientLayer(new Response("{}", { status: 201 })), { excludeTestServices: true })(
  "Wompi uncertain response adapter",
  (it) => {
    it.effect("fences malformed success as ambiguous", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(createPaymentSource);
        expect(failure).toEqual(new WompiSourceCreationFailed({ certainty: "ambiguous" }));
      })
    );
  }
);

layer(clientLayer(new Response('{"data":{"id":3891,"status":"DECLINED"}}', { status: 201 })), {
  excludeTestServices: true,
})("Wompi declined source adapter", (it) => {
  it.effect("maps a declined source without retaining provider details", () =>
    Effect.gen(function* () {
      expect(yield* createPaymentSource).toEqual({ _tag: "Refused" });
    })
  );
});

layer(clientLayer(new Response('{"data":{"id":3891,"status":"ERROR"}}', { status: 201 })), {
  excludeTestServices: true,
})("Wompi errored source adapter", (it) => {
  it.effect("maps a definitive provider error to refusal", () =>
    Effect.gen(function* () {
      expect(yield* createPaymentSource).toEqual({ _tag: "Refused" });
    })
  );
});

layer(clientLayer(new Response('{"data":{"id":3891,"status":"PENDING"}}', { status: 201 })), {
  excludeTestServices: true,
})("Wompi pending source adapter", (it) => {
  it.effect("fences an unresolved source as ambiguous", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(createPaymentSource);
      expect(failure).toEqual(new WompiSourceCreationFailed({ certainty: "ambiguous" }));
    })
  );
});

layer(clientLayer(new Response("provider secret", { status: 503 })), {
  excludeTestServices: true,
})("Wompi unavailable source adapter", (it) => {
  it.effect("fences a provider outage as ambiguous without exposing its body", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(createPaymentSource);
      expect(failure).toEqual(new WompiSourceCreationFailed({ certainty: "ambiguous" }));
    })
  );
});

layer(
  clientLayerWithConfig(new Response("contract"), new Response(null, { status: 101 }), config),
  { excludeTestServices: true }
)("Wompi premature merchant response adapter", (it) => {
  it.effect("rejects a merchant response below the successful range", () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(loadContracts))._tag).toBe("WompiContractsUnavailable");
    })
  );
});

layer(
  clientLayerWithConfig(
    new Response("contract"),
    new Response("provider secret", { status: 503 }),
    config
  ),
  { excludeTestServices: true }
)("Wompi unavailable merchant adapter", (it) => {
  it.effect("rejects a non-success merchant response generically", () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(loadContracts))._tag).toBe("WompiContractsUnavailable");
    })
  );
});

layer(
  clientLayerWithConfig(
    new Response("contract"),
    new Response("not-json", { status: 200 }),
    config
  ),
  { excludeTestServices: true }
)("Wompi invalid JSON merchant adapter", (it) => {
  it.effect("rejects a non-JSON merchant response generically", () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(loadContracts))._tag).toBe("WompiContractsUnavailable");
    })
  );
});

layer(
  clientLayerWithConfig(new Response("contract"), new Response("{}", { status: 200 }), config),
  { excludeTestServices: true }
)("Wompi malformed merchant adapter", (it) => {
  it.effect("rejects malformed merchant contracts generically", () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(loadContracts))._tag).toBe("WompiContractsUnavailable");
    })
  );
});

layer(
  clientLayerWithConfig(
    new Response('{"data":{"id":3891,"status":"AVAILABLE"}}', { status: 201 }),
    new Response(merchantBody, { status: 200 }),
    productionConfig
  ),
  { excludeTestServices: true }
)("Wompi production environment adapter", (it) => {
  it.effect("accepts matching production key prefixes", () =>
    Effect.gen(function* () {
      expect(yield* createPaymentSource).toEqual({ _tag: "Available", sourceId: 3891 });
    })
  );
});

const layerWithConfig = (
  configLayer: Layer.Layer<never, Config.ConfigError>
): Layer.Layer<WompiEnrollmentClient, Config.ConfigError> =>
  clientLayerWithConfig(
    new Response("{}"),
    new Response(merchantBody, { status: 200 }),
    configLayer
  );

for (const [name, configLayer] of [
  ["public prefix", mismatchedPublicConfig],
  ["private prefix", mismatchedPrivateConfig],
  ["private shape", invalidPrivateConfig],
] as const) {
  it.effect(`rejects an invalid ${name}`, () => {
    const runtime = ManagedRuntime.make(layerWithConfig(configLayer));
    return Effect.gen(function* () {
      const exit = yield* Effect.promise(() => runtime.runPromiseExit(loadContracts));
      expect(Exit.isFailure(exit)).toBe(true);
    }).pipe(Effect.ensuring(Effect.promise(() => runtime.dispose())));
  });
}
