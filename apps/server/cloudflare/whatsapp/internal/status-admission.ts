import { DateTime, Effect } from "effect";
import {
  type WhatsAppStatusLookupAdmission,
  WhatsAppStatusUnavailable,
} from "../../../src/shell/channels/whatsapp/contract";
import { admitResource } from "../../resource-admission/operations";
import {
  ResourceAdmissionCharges,
  ResourceAdmissionDurationMs,
  ResourceAdmissionEpochMs,
  ResourceAdmissionGrantId,
  ResourceAdmissionLimit,
  ResourceAdmissionPolicies,
  ResourceAdmissionPolicyKey,
  ResourceAdmissionScopeKey,
  ResourceAdmissionUnits,
} from "../../resource-admission/contract";
import { newId } from "../../secret-material/operations";

const minuteMs = 60_000;
const hourMs = 3_600_000;
const maximumHourlyLookups = 500;
const hexRadix = 16;
const sourceKey = ResourceAdmissionPolicyKey.make("whatsapp.statusLookup.source.v1");
const globalKey = ResourceAdmissionPolicyKey.make("whatsapp.statusLookup.global.v1");
const policies = ResourceAdmissionPolicies.make([
  {
    kind: "rolling_window",
    dimension: "source",
    key: sourceKey,
    durationMs: ResourceAdmissionDurationMs.make(minuteMs),
    limit: ResourceAdmissionLimit.make(1),
  },
  {
    kind: "rolling_window",
    dimension: "operation",
    key: globalKey,
    durationMs: ResourceAdmissionDurationMs.make(hourMs),
    limit: ResourceAdmissionLimit.make(maximumHourlyLookups),
  },
]);

/** Admit after signature verification, before provider I/O. Failures permit a retry next minute. */
export const makeStatusLookupAdmission =
  (database: D1Database): WhatsAppStatusLookupAdmission =>
  (request) =>
    Effect.gen(function* () {
      const digest = yield* Effect.tryPromise(() =>
        crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            `${request.businessPhoneNumberId.length}:${request.businessPhoneNumberId}${request.messageId}`
          )
        )
      );
      const scope = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(hexRadix).padStart(2, "0")
      ).join("");
      yield* admitResource(
        {
          database,
          policies,
          nowEpochMs: () =>
            ResourceAdmissionEpochMs.make(DateTime.toEpochMillis(request.receivedAt)),
        },
        {
          grantId: ResourceAdmissionGrantId.make(newId()),
          statements: [],
          charges: ResourceAdmissionCharges.make([
            {
              policyKey: sourceKey,
              scopeKey: ResourceAdmissionScopeKey.make(scope),
              units: ResourceAdmissionUnits.make(1),
            },
            {
              policyKey: globalKey,
              scopeKey: ResourceAdmissionScopeKey.make("all"),
              units: ResourceAdmissionUnits.make(1),
            },
          ]),
        }
      );
    }).pipe(
      Effect.asVoid,
      Effect.mapError(() => new WhatsAppStatusUnavailable())
    );
