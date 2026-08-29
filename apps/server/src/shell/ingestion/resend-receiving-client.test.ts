import { expect, layer } from "@effect/vitest";
import { type Config, ConfigProvider, Effect, Fiber, Layer, Option, Result, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { ResendReceivedEmailId } from "~/core/ingestion/reference";
import { receivedEmailFixture } from "~/shell/ingestion/fixtures/resend-received-email";
import { ResendReceivingClient } from "./resend-receiving-client";

const testLayer = (
  http: HttpClient.HttpClient
): Layer.Layer<ResendReceivingClient, Config.ConfigError> =>
  ResendReceivingClient.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(HttpClient.HttpClient, http),
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ RESEND_API_KEY: "test-resend-api-key" })
        )
      )
    )
  );

const mockClient = (
  handler: (
    request: HttpClientRequest.HttpClientRequest
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>
): HttpClient.HttpClient =>
  HttpClient.makeWith<
    HttpClientError.HttpClientError,
    never,
    HttpClientError.HttpClientError,
    never
  >((request) => Effect.flatMap(request, handler), Effect.succeed);

const pngImage = (width: number, height: number): Uint8Array =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
  ]);
const decodeBase64 = Schema.decodeSync(Schema.Uint8ArrayFromBase64);
const pngSignature = decodeBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg=="
);
const successfulRequests: Array<string> = [];
const successfulHttp = mockClient((request) => {
  successfulRequests.push(request.url);
  if (request.url.endsWith("/attachments/inline-1")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({ download_url: "https://inbound-cdn.resend.com/signed/image" })
      )
    );
  }
  if (request.url === "https://inbound-cdn.resend.com/signed/image") {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(pngSignature, { headers: { "content-type": "image/png" } })
      )
    );
  }
  return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(receivedEmailFixture)));
});

const stalledBodyHttp = mockClient((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      new Response(
        new ReadableStream<Uint8Array>({
          pull: (): void => undefined,
        })
      )
    )
  )
);

layer(testLayer(stalledBodyHttp))("Resend receiving deadline", (it) => {
  it.effect("bounds a provider response whose body never completes", () =>
    Effect.gen(function* () {
      const client = yield* ResendReceivingClient;
      const observed = yield* client
        .retrieveEmail(ResendReceivedEmailId.make("stalled-provider-body"))
        .pipe(Effect.result, Effect.timeoutOption("181 seconds"), Effect.forkChild);

      yield* TestClock.adjust("181 seconds");
      const result = yield* Fiber.join(observed);

      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(Result.isFailure(result.value)).toBe(true);
        if (Result.isFailure(result.value)) {
          expect(result.value.failure.reason).toBe("provider-unavailable");
        }
      }
    })
  );
});

layer(testLayer(successfulHttp))("Resend receiving projection", (it) => {
  it.effect("projects bounded inline images and never retrieves ordinary attachments", () =>
    Effect.gen(function* () {
      const client = yield* ResendReceivingClient;
      const email = yield* client.retrieveEmail(ResendReceivedEmailId.make("email_fixture_1"));

      expect(email.inlineImages).toHaveLength(1);
      expect(email.inlineImages[0]?.content).toEqual(pngSignature);
      expect(Option.getOrThrow(email.messageId)).toBe("provider-message-1");
      expect(successfulRequests.some((url) => url.includes("ordinary-1"))).toBe(false);
    })
  );
});

const unsafeDestinations: Readonly<Record<string, string>> = {
  "destination-protocol": "http://127.0.0.1/internal",
  "destination-host": "https://example.test/image",
  "destination-port": "https://inbound-cdn.resend.com:444/image",
  "destination-username": "https://user@inbound-cdn.resend.com/image",
  "destination-password": "https://user:password@inbound-cdn.resend.com/image",
};
const unsafeDestinationHttp = mockClient((request) => {
  const id =
    Object.keys(unsafeDestinations).find((candidate) => request.url.includes(candidate)) ??
    "destination-protocol";
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      request.url.endsWith("/attachments/inline-1")
        ? Response.json({ download_url: unsafeDestinations[id] })
        : Response.json({
            id,
            from: "alerts@example.test",
            to: ["fixture@ingest.fidyapp.com"],
            subject: "Compra",
            text: "COP 1",
            html: null,
            message_id: null,
            created_at: "2026-08-28T12:00:00Z",
            attachments: [
              {
                id: "inline-1",
                content_type: "image/png",
                content_disposition: "inline",
                content_id: "image",
                size: 3,
              },
            ],
          })
    )
  );
});

layer(testLayer(unsafeDestinationHttp))("Resend receiving destination validation", (it) => {
  for (const id of Object.keys(unsafeDestinations)) {
    it.effect(`rejects unsafe ${id}`, () =>
      Effect.gen(function* () {
        const client = yield* ResendReceivingClient;
        const outcome = yield* Effect.exit(client.retrieveEmail(ResendReceivedEmailId.make(id)));
        expect(outcome._tag).toBe("Failure");
      })
    );
  }
});

const spoofedImageHttp = mockClient((request) => {
  if (request.url.endsWith("/attachments/inline-1")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({ download_url: "https://inbound-cdn.resend.com/signed/spoofed" })
      )
    );
  }
  if (request.url === "https://inbound-cdn.resend.com/signed/spoofed") {
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(new Uint8Array([1, 2, 3])))
    );
  }
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      Response.json({
        ...receivedEmailFixture,
        id: "email_fixture_spoofed",
        attachments: [{ ...receivedEmailFixture.attachments[0], size: 3 }],
      })
    )
  );
});

layer(testLayer(spoofedImageHttp))("Resend receiving media validation", (it) => {
  it.effect("rejects bytes whose signature does not match the declared image type", () =>
    Effect.gen(function* () {
      const client = yield* ResendReceivingClient;
      const outcome = yield* Effect.exit(
        client.retrieveEmail(ResendReceivedEmailId.make("email_fixture_spoofed"))
      );
      expect(outcome._tag).toBe("Failure");
    })
  );
});

const oversizedImageHttp = (input: {
  readonly fixtureId: string;
  readonly signedPath: string;
  readonly width: number;
  readonly height: number;
}): HttpClient.HttpClient =>
  mockClient((request) => {
    if (request.url.endsWith("/attachments/inline-1")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            download_url: `https://inbound-cdn.resend.com/signed/${input.signedPath}`,
          })
        )
      );
    }
    if (request.url.includes("inbound-cdn.resend.com")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(pngImage(input.width, input.height)))
      );
    }
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          ...receivedEmailFixture,
          id: input.fixtureId,
          attachments: [{ ...receivedEmailFixture.attachments[0], size: 24 }],
        })
      )
    );
  });

const oversizedDimensionsHttp = oversizedImageHttp({
  fixtureId: "email_fixture_oversized_dimensions",
  signedPath: "oversized-dimensions",
  width: 100_000,
  height: 100_000,
});
const oversizedHeightHttp = oversizedImageHttp({
  fixtureId: "email_fixture_oversized_height",
  signedPath: "oversized-height",
  width: 1,
  height: 100_000,
});

layer(testLayer(oversizedDimensionsHttp))("Resend receiving decoded image limits", (it) => {
  it.effect("rejects a small compressed image declaring excessive width", () =>
    Effect.gen(function* () {
      const client = yield* ResendReceivingClient;
      expect(
        (yield* Effect.exit(
          client.retrieveEmail(ResendReceivedEmailId.make("email_fixture_oversized_dimensions"))
        ))._tag
      ).toBe("Failure");
    })
  );
});

layer(testLayer(oversizedHeightHttp))("Resend receiving decoded image height limit", (it) => {
  it.effect("rejects a small compressed image declaring excessive height", () =>
    Effect.gen(function* () {
      const client = yield* ResendReceivingClient;
      expect(
        (yield* Effect.exit(
          client.retrieveEmail(ResendReceivedEmailId.make("email_fixture_oversized_height"))
        ))._tag
      ).toBe("Failure");
    })
  );
});

type MetadataAttachment = Readonly<{
  id: string;
  content_type: string;
  content_disposition: string;
  content_id: string;
  size: number;
}>;

const metadataAttachments = (id: string): ReadonlyArray<MetadataAttachment> => {
  if (id === "metadata-too-many") {
    return Array.from({ length: 9 }, (_, index) => ({
      id: `inline-${index}`,
      content_type: "image/png",
      content_disposition: "inline",
      content_id: `image-${index}`,
      size: 8,
    }));
  }
  if (id === "metadata-image-too-large") {
    return [
      {
        id: "inline-large",
        content_type: "image/png",
        content_disposition: "inline",
        content_id: "large",
        size: 1_048_577,
      },
    ];
  }
  return [];
};

const metadataEdgeHttp = mockClient((request) => {
  const id = request.url.split("/").at(-1) ?? "";
  if (id === "metadata-rate-limited") {
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 429 })));
  }
  if (id === "metadata-rejected") {
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 404 })));
  }
  if (id === "metadata-malformed") {
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("not-json")));
  }
  if (id === "metadata-too-large") {
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("x".repeat(1_048_577))));
  }
  const attachments = metadataAttachments(id);
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      Response.json({
        id,
        from: "alerts@example.test",
        to: ["fixture@ingest.fidyapp.com"],
        subject: "Compra",
        text: null,
        html: id === "metadata-html" ? "<p>COP 1</p>" : null,
        message_id: null,
        created_at: "2026-08-28T12:00:00Z",
        attachments,
      })
    )
  );
});

layer(testLayer(metadataEdgeHttp))("Resend receiving metadata limits", (it) => {
  for (const id of [
    "metadata-rate-limited",
    "metadata-rejected",
    "metadata-malformed",
    "metadata-too-large",
    "metadata-too-many",
    "metadata-image-too-large",
  ]) {
    it.effect(`rejects ${id}`, () =>
      Effect.gen(function* () {
        const client = yield* ResendReceivingClient;
        expect(
          (yield* Effect.exit(client.retrieveEmail(ResendReceivedEmailId.make(id))))._tag
        ).toBe("Failure");
      })
    );
  }
  it.effect("accepts bounded email projections with and without optional content", () =>
    Effect.gen(function* () {
      const client = yield* ResendReceivingClient;
      const email = yield* client.retrieveEmail(ResendReceivedEmailId.make("metadata-empty"));
      expect(Option.isNone(email.text)).toBe(true);
      expect(Option.isNone(email.html)).toBe(true);
      expect(Option.isNone(email.messageId)).toBe(true);
      expect(email.inlineImages).toEqual([]);

      const withHtml = yield* client.retrieveEmail(ResendReceivedEmailId.make("metadata-html"));
      expect(Option.getOrThrow(withHtml.html)).toBe("<p>COP 1</p>");
    })
  );
});

const imageResponseEdgeHttp = mockClient((request) => {
  const oversized = request.url.includes("image-body-too-large");
  if (request.url.includes("inbound-cdn.resend.com")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        oversized ? new Response(new Uint8Array(1_048_577)) : new Response("", { status: 503 })
      )
    );
  }
  if (request.url.includes("/attachments/")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          download_url: `https://inbound-cdn.resend.com/signed/${
            oversized ? "image-body-too-large" : "image-unavailable"
          }`,
        })
      )
    );
  }
  const id = request.url.split("/").at(-1) ?? "";
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      Response.json({
        ...receivedEmailFixture,
        id,
        attachments: [{ ...receivedEmailFixture.attachments[0], size: 8 }],
      })
    )
  );
});

layer(testLayer(imageResponseEdgeHttp))("Resend receiving image response limits", (it) => {
  for (const id of ["image-unavailable", "image-body-too-large"]) {
    it.effect(`rejects ${id}`, () =>
      Effect.gen(function* () {
        const client = yield* ResendReceivingClient;
        expect(
          (yield* Effect.exit(client.retrieveEmail(ResendReceivedEmailId.make(id))))._tag
        ).toBe("Failure");
      })
    );
  }
});

type HostileImageId = "image-format-mismatch" | "image-animated";
const hostileImageIds: ReadonlyArray<HostileImageId> = ["image-format-mismatch", "image-animated"];
const defaultHostileImageId: HostileImageId = "image-format-mismatch";
const hostileImageStructures: Readonly<
  Record<HostileImageId, { declaredMediaType: string; bytes: Uint8Array }>
> = {
  "image-format-mismatch": {
    declaredMediaType: "image/jpeg",
    bytes: pngSignature,
  },
  "image-animated": {
    declaredMediaType: "image/gif",
    bytes: decodeBase64(
      "R0lGODlhAQABAIAAAExpcf8AACH/C05FVFNDQVBFMi4wAwEAAAAh+QQFCgAAACwAAAAAAQABAAACAkwBACH5BAUKAAAALAAAAAABAAEAgExpcQAA/wICTAEAOw=="
    ),
  },
};
const hostileImageStructureHttp = mockClient((request) => {
  const id = Option.getOrElse(
    Option.fromUndefinedOr(hostileImageIds.find((candidate) => request.url.includes(candidate))),
    () => defaultHostileImageId
  );
  const selected = hostileImageStructures[id];
  if (request.url.includes("inbound-cdn.resend.com")) {
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(selected.bytes)));
  }
  if (request.url.includes("/attachments/")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({ download_url: `https://inbound-cdn.resend.com/signed/${id}` })
      )
    );
  }
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      Response.json({
        ...receivedEmailFixture,
        id,
        attachments: [
          {
            ...receivedEmailFixture.attachments[0],
            content_type: selected.declaredMediaType,
            size: selected.bytes.byteLength,
          },
        ],
      })
    )
  );
});

layer(testLayer(hostileImageStructureHttp))("Resend receiving image structure limits", (it) => {
  for (const id of hostileImageIds) {
    it.effect(`rejects ${id}`, () =>
      Effect.gen(function* () {
        const client = yield* ResendReceivingClient;
        expect(
          (yield* Effect.exit(client.retrieveEmail(ResendReceivedEmailId.make(id))))._tag
        ).toBe("Failure");
      })
    );
  }
});

type ImageKind = "jpeg" | "gif" | "webp";
const imageKinds: ReadonlyArray<ImageKind> = ["jpeg", "gif", "webp"];
const defaultImageKind: ImageKind = "jpeg";
const imageCases: Readonly<Record<ImageKind, { mediaType: string; bytes: Uint8Array }>> = {
  jpeg: {
    mediaType: "image/jpeg",
    bytes: decodeBase64(
      "/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJUAB//Z"
    ),
  },
  gif: {
    mediaType: "image/gif",
    bytes: decodeBase64("R0lGODlhAQABAIAAAExpcQAAACH5BAUAAAAALAAAAAABAAEAAAICTAEAOw=="),
  },
  webp: {
    mediaType: "image/webp",
    bytes: decodeBase64("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v02aAA="),
  },
};
const mediaTypeHttp = mockClient((request) => {
  const kind = Option.fromUndefinedOr(
    imageKinds.find((candidate) => request.url.includes(candidate))
  );
  if (request.url.includes("/attachments/")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          download_url: `https://inbound-cdn.resend.com/signed/${Option.getOrElse(kind, () => "jpeg")}`,
        })
      )
    );
  }
  if (request.url.includes("inbound-cdn.resend.com")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          Option.match(kind, { onNone: () => null, onSome: (value) => imageCases[value].bytes })
        )
      )
    );
  }
  const selectedKind = Option.getOrElse(kind, () => defaultImageKind);
  const selected = imageCases[selectedKind];
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      Response.json({
        ...receivedEmailFixture,
        id: `media-${selectedKind}`,
        attachments: [
          {
            id: `inline-${selectedKind}`,
            content_type: selected.mediaType,
            content_disposition: "inline",
            content_id: `image-${selectedKind}`,
            size: selected.bytes.byteLength,
          },
        ],
      })
    )
  );
});

layer(testLayer(mediaTypeHttp))("Resend receiving supported media signatures", (it) => {
  for (const kind of imageKinds) {
    it.effect(`accepts ${kind}`, () =>
      Effect.gen(function* () {
        const client = yield* ResendReceivingClient;
        const email = yield* client.retrieveEmail(ResendReceivedEmailId.make(`media-${kind}`));
        expect(email.inlineImages[0]?.mediaType).toBe(imageCases[kind].mediaType);
      })
    );
  }
});

const redirectRequests: Array<{
  readonly url: string;
  readonly redirect: Option.Option<"error" | "follow" | "manual">;
}> = [];
const redirectFetchRequest = (
  input: Parameters<typeof globalThis.fetch>[0],
  init: Parameters<typeof globalThis.fetch>[1]
): Promise<Response> => {
  let url: string;
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.href;
  else url = input.url;
  redirectRequests.push({
    url,
    redirect: Option.fromUndefinedOr(init?.redirect),
  });
  if (url.includes("inbound-cdn.resend.com")) {
    return Promise.resolve(
      new Response("", {
        status: 302,
        headers: { location: "http://127.0.0.1/internal" },
      })
    );
  }
  if (url.endsWith("/attachments/inline-1")) {
    return Promise.resolve(
      Response.json({
        download_url: "https://inbound-cdn.resend.com/signed/redirect",
      })
    );
  }
  return Promise.resolve(
    Response.json({
      ...receivedEmailFixture,
      id: "email_fixture_redirect",
      attachments: [{ ...receivedEmailFixture.attachments[0], size: 24 }],
    })
  );
};
const redirectObservingFetch: typeof globalThis.fetch = Object.assign(redirectFetchRequest, {
  preconnect: (): void => undefined,
});

const redirectLayer = ResendReceivingClient.layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(
    Layer.succeed(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ RESEND_API_KEY: "test-resend-api-key" })
    )
  ),
  Layer.provide(Layer.succeed(FetchHttpClient.Fetch, redirectObservingFetch))
);

layer(redirectLayer)("Resend receiving redirect policy", (it) => {
  it.effect("uses manual redirects and rejects a CDN redirect without a second request", () =>
    Effect.gen(function* () {
      redirectRequests.length = 0;
      const client = yield* ResendReceivingClient;
      expect(
        (yield* Effect.exit(
          client.retrieveEmail(ResendReceivedEmailId.make("email_fixture_redirect"))
        ))._tag
      ).toBe("Failure");
      expect(redirectRequests.map((request) => Option.getOrUndefined(request.redirect))).toEqual([
        "manual",
        "manual",
        "manual",
      ]);
      expect(redirectRequests.some((request) => request.url.includes("127.0.0.1"))).toBe(false);
    })
  );
});
