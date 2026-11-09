import { expect, it } from "@effect/vitest";
import { Effect, Exit, Schema } from "effect";
import { makeProactivityTemplateSender } from "./runtime";
import {
  HostedDeliveryCorrelationToken,
  PreparedProactivityTemplate,
  WhatsAppBusinessPhoneNumberId,
} from "./contract";
import { WhatsAppBusinessScopedUserId } from "~/core/identity/contract";

const body = "Fidy te avisa: {{1}} Más en Fidy.";
const configuration = {
  name: "fidy_proactivity",
  language: "es",
  approval: "approved",
  body,
};
const fixedLength = body.replace("{{1}}", "").length;

it.effect("refuses provider-invalid template whitespace before sending", () =>
  Effect.gen(function* () {
    const sender = makeProactivityTemplateSender({
      configuration,
      outboundHttp: { execute: () => Effect.die("must not contact provider") },
    });
    for (const invalid of ["uno\ndos", "uno\rdos", "uno\tdos", "uno     dos"]) {
      expect(Exit.isFailure(yield* Effect.exit(sender.prepare(invalid)))).toBe(true);
    }
    expect((yield* sender.prepare("uno    dos")).parameter).toBe("uno    dos");
  })
);

it.effect("sends the full approved body and preserves literal replacement characters", () =>
  Effect.gen(function* () {
    let submitted = "";
    const sender = makeProactivityTemplateSender({
      configuration,
      outboundHttp: {
        execute: (input) => {
          if (input._tag !== "KapsoMessages") return Effect.die("wrong provider");
          submitted = input.body;
          return Effect.succeed({
            status: 200,
            headers: {},
            body: new TextEncoder().encode(
              '{"messaging_product":"whatsapp","messages":[{"id":"wamid.proactivity"}]}'
            ),
          });
        },
      },
    });
    const parameter = "Aviso de prueba: $& y $` son texto literal.";
    const prepared = yield* sender.prepare(parameter);
    expect(prepared.text).toBe(`Fidy te avisa: ${parameter} Más en Fidy.`);
    yield* sender.send({
      recipient: WhatsAppBusinessScopedUserId.make("CO.573001234567"),
      businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123456789"),
      correlationToken: HostedDeliveryCorrelationToken.make("11111111-1111-4111-8111-111111111111"),
      template: prepared,
    });
    expect(
      yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(submitted)
    ).toMatchObject({
      template: {
        name: "fidy_proactivity",
        language: { code: "es" },
        components: [{ type: "body", parameters: [{ type: "text", text: parameter }] }],
      },
    });
  })
);

it.effect("bounds the entire rendered message without clipping the supplied content", () =>
  Effect.gen(function* () {
    let called = false;
    const sender = makeProactivityTemplateSender({
      configuration,
      outboundHttp: {
        execute: () => {
          called = true;
          return Effect.die("must not send");
        },
      },
    });
    const maximum = "x".repeat(1024 - fixedLength);
    const prepared = yield* sender.prepare(maximum);
    expect(prepared.text.length).toBe(1024);
    expect(prepared.parameter).toBe(maximum);
    expect(Exit.isFailure(yield* Effect.exit(sender.prepare(`${maximum}x`)))).toBe(true);
    expect(
      Schema.decodeOption(PreparedProactivityTemplate)({
        ...prepared,
        text: maximum,
      })._tag
    ).toBe("None");
    expect(called).toBe(false);
  })
);

it.effect("refuses the provider-rejected short body before any send", () =>
  Effect.gen(function* () {
    let called = false;
    const sender = makeProactivityTemplateSender({
      configuration: { ...configuration, body: "Fidy: {{1}}" },
      outboundHttp: {
        execute: () => {
          called = true;
          return Effect.die("must not send");
        },
      },
    });
    expect(Exit.isFailure(yield* Effect.exit(sender.prepare("Aviso de prueba")))).toBe(true);
    expect(called).toBe(false);
  })
);
