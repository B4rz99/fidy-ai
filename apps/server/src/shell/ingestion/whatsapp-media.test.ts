import { expect, layer } from "@effect/vitest";
import { Effect } from "effect";
import { WhatsAppBusinessPhoneNumberId, WhatsAppMediaId } from "~/shell/channels/whatsapp/contract";
import type { OutboundHttpService } from "~/shell/outbound-http/operations";
import { TestCrypto } from "~/shell/testing/crypto-harness";
import { readWhatsAppStatementMedia } from "./operations";

const bytes = new TextEncoder().encode("date,amount,currency\n2026-04-01,13000,COP");
const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const metadata = {
  id: "statement123",
  mime_type: "text/csv",
  sha256,
  file_size: String(bytes.length),
  download_url: "https://api.kapso.ai/meta/whatsapp/media_download?token=signed-private-token",
  download_url_expires_at: "2026-04-03T12:14:00Z",
};
layer(TestCrypto)((it) => {
  it.effect("refuses redirected, failed and length-mismatched downloads", () =>
    Effect.gen(function* () {
      for (const download of [
        { status: 302, body: bytes },
        { status: 503, body: bytes },
        { status: 200, body: new Uint8Array(bytes.length + 1) },
        { status: 200, body: new Uint8Array(0) },
      ]) {
        const outbound: OutboundHttpService = {
          execute: (request) =>
            Effect.succeed(
              request._tag === "KapsoMediaMetadata"
                ? {
                    status: 200,
                    headers: {},
                    body: new TextEncoder().encode(JSON.stringify(metadata)),
                  }
                : { ...download, headers: {} }
            ),
        };
        expect(
          (yield* readWhatsAppStatementMedia({ ...input, outbound }).pipe(Effect.flip))._tag
        ).toBe("StatementMediaUnavailable");
      }
    })
  );
  it.effect("rejects a downloaded body whose declared digest does not match its bytes", () =>
    Effect.gen(function* () {
      const outbound: OutboundHttpService = {
        execute: (request) =>
          Effect.succeed({
            status: 200,
            headers: {},
            body:
              request._tag === "KapsoMediaMetadata"
                ? new TextEncoder().encode(JSON.stringify({ ...metadata, sha256: "0".repeat(64) }))
                : bytes,
          }),
      };
      expect(
        (yield* readWhatsAppStatementMedia({ ...input, outbound }).pipe(Effect.flip))._tag
      ).toBe("StatementMediaUnavailable");
    })
  );

  const input = {
    mediaId: WhatsAppMediaId.make("statement123"),
    businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("12345"),
    current: Date.parse("2026-04-03T12:10:00Z"),
  };

  it.effect(
    "retrieves bounded statement bytes through metadata and the fixed signed-download operation",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const outbound: OutboundHttpService = {
          execute: (request) => {
            calls += 1;
            return Effect.succeed({
              status: 200,
              headers: {},
              body:
                request._tag === "KapsoMediaMetadata"
                  ? new TextEncoder().encode(JSON.stringify(metadata))
                  : bytes,
            });
          },
        };
        expect(yield* readWhatsAppStatementMedia({ ...input, outbound })).toEqual({
          bytes,
          sha256,
          mimeType: "text/csv",
        });
        expect(calls).toBe(2);
      })
  );

  it.effect(
    "rejects foreign origins, wrong media, expired links and non-statement MIME before download",
    () =>
      Effect.gen(function* () {
        for (const change of [
          { download_url: "https://attacker.invalid/?token=secret" },
          {
            download_url:
              "https://user:secret@api.kapso.ai/meta/whatsapp/media_download?token=signed",
          },
          { download_url: "http://api.kapso.ai/meta/whatsapp/media_download?token=signed" },
          {
            download_url:
              "https://api.kapso.ai/meta/whatsapp/media_download?token=signed&extra=secret",
          },
          {
            download_url:
              "https://api.kapso.ai/meta/whatsapp/media_download?token=signed&token=other",
          },
          {
            download_url: "https://api.kapso.ai/meta/whatsapp/media_download?token=signed#fragment",
          },
          { download_url: "https://api.kapso.ai/meta/whatsapp/media_download?token=" },
          { download_url: "https://api.kapso.ai/other?token=signed" },
          { download_url_expires_at: "not-a-time" },
          { id: "foreign" },
          { download_url_expires_at: "2026-04-03T12:09:00Z" },
          { mime_type: "image/jpeg" },
          { file_size: "999999999" },
        ]) {
          let calls = 0;
          const outbound: OutboundHttpService = {
            execute: () => {
              calls += 1;
              return Effect.succeed({
                status: 200,
                headers: {},
                body: new TextEncoder().encode(JSON.stringify({ ...metadata, ...change })),
              });
            },
          };
          expect(
            (yield* readWhatsAppStatementMedia({ ...input, outbound }).pipe(Effect.flip))._tag
          ).toBe("StatementMediaUnavailable");
          expect(calls).toBe(1);
        }
      })
  );
});
