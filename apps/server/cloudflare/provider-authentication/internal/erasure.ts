import { browserPairingsForErasureQuery } from "../../browser-login/operations";
import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "provider_authentication_attempts",
    dataClass: "credentials",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM provider_authentication_attempts r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM provider_authentication_attempts r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM provider_authentication_attempts AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "provider_credentials",
    dataClass: "credentials",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM provider_credentials r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM provider_credentials r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM provider_credentials AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "whatsapp_provider_handoffs",
    dataClass: "credentials",
    dependencies: ["provider_authentication_attempts"],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => {
      const pairings = browserPairingsForErasureQuery(userId);
      return {
        sql: `SELECT CAST(r.rowid AS TEXT) AS rowRef FROM whatsapp_provider_handoffs r WHERE r.pairing_id IN (${pairings.sql})`,
        params: pairings.params,
      };
    },
    remaining: (userId) => {
      const pairings = browserPairingsForErasureQuery(userId);
      return {
        sql: `SELECT 1 FROM whatsapp_provider_handoffs r WHERE r.pairing_id IN (${pairings.sql})`,
        params: pairings.params,
      };
    },
    remove: (scope) => {
      const pairings = browserPairingsForErasureQuery(scope.userId);
      return [
        {
          sql: `DELETE FROM whatsapp_provider_handoffs AS r WHERE r.pairing_id IN (${pairings.sql}) AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))`,
          params: [...pairings.params, scope.rowRefsJson],
        },
      ];
    },
  },
  {
    id: "whatsapp_signup_invitations",
    dataClass: "credentials",
    dependencies: ["provider_authentication_attempts"],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => {
      const pairings = browserPairingsForErasureQuery(userId);
      return {
        sql: `SELECT CAST(r.rowid AS TEXT) AS rowRef FROM whatsapp_signup_invitations r WHERE r.pairing_id IN (${pairings.sql})`,
        params: pairings.params,
      };
    },
    remaining: (userId) => {
      const pairings = browserPairingsForErasureQuery(userId);
      return {
        sql: `SELECT 1 FROM whatsapp_signup_invitations r WHERE r.pairing_id IN (${pairings.sql})`,
        params: pairings.params,
      };
    },
    remove: (scope) => {
      const pairings = browserPairingsForErasureQuery(scope.userId);
      return [
        {
          sql: `DELETE FROM whatsapp_signup_invitations AS r WHERE r.pairing_id IN (${pairings.sql}) AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))`,
          params: [...pairings.params, scope.rowRefsJson],
        },
      ];
    },
  },
];
