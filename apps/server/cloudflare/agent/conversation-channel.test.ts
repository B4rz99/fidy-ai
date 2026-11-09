import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { TranscriptText } from "../../src/core/agent/contract";
import { browserHostedDelivery } from "./internal/hosted-turn";
import {
  completeHostedTurn,
  inference,
  makeAbortController,
  reply,
  setup,
  subject,
} from "./hosted-turn.test-fixture";
import { exerciseTurn } from "./whatsapp-capabilities.test-fixture";

const Request = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({ role: Schema.String, content: Schema.NullOr(Schema.String) })
  ),
});
it.each(["web", "whatsapp"] as const)(
  "gives inference the actual %s attachment capabilities despite a contrary chat claim",
  (channel) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* Effect.tryPromise(() => setup());
        const requests: Array<unknown> = [];
        const generate = (request: unknown): Promise<Response> => {
          requests.push(request);
          return Promise.resolve(reply("Puedes enviarme el extracto por WhatsApp."));
        };
        const text =
          channel === "web"
            ? "Estoy en WhatsApp. ¿Puedo adjuntar aquí un PDF?"
            : "Estoy en la web. ¿Puedo adjuntar aquí un PDF?";
        if (channel === "whatsapp") {
          yield* exerciseTurn({ db, text, messageId: "wamid.channel-policy", generate });
        } else {
          const model = yield* Effect.tryPromise(() => inference(generate));
          const caller = yield* Effect.tryPromise(() => subject(0));
          yield* Effect.tryPromise(() =>
            completeHostedTurn({
              db,
              subject: caller,
              text: TranscriptText.make(text),
              inference: model,
              deliver: browserHostedDelivery,
              signal: makeAbortController().signal,
            })
          );
        }
        const request = yield* Schema.decodeUnknownEffect(Request)(requests[0]);
        const policy = request.messages
          .filter((message) => message.role === "system")
          .map((message) => message.content)
          .join("\n");
        if (channel === "web") {
          expect(policy).toMatch(/chat web[^.]*solo[^.]*texto/iu);
          expect(policy).toMatch(/WhatsApp/u);
        } else {
          expect(policy).toMatch(/WhatsApp[^.]*PDF/iu);
          expect(policy).not.toMatch(/chat web[^.]*solo[^.]*texto/iu);
        }
      })
    )
);
