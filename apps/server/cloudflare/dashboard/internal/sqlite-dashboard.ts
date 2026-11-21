import { describeDashboardEffect } from "./oauth-review";
import {
  canonicalAdmissionUnavailable,
  commitLocalWrite,
  prepareLocalWrite,
  runLocalMutation,
} from "../../canonical-admission/operations";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { DateTime, Effect, Option, Result, Schema } from "effect";
import {
  DashboardCatalog,
  DashboardDocument,
  DashboardEdit,
} from "../../../src/core/dashboard/contract";
import {
  applyDashboardEdit,
  collectDashboardCategoryReferences,
  makeDashboardCatalog,
} from "../../../src/core/dashboard/operations";
import { categoryIds } from "../../../src/core/categories/contract";
import { listLaunchCategories } from "../../../src/core/categories/operations";
import type { UserId } from "../../../src/core/identity/contract";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import { DashboardUnavailable, DashboardView } from "../../../src/shell/dashboard/contract";
import { renderDashboardView } from "../../../src/shell/dashboard/operations";
import { type LocalMutationResult } from "../../canonical-admission/contract";

import { boundedJsonBody } from "../../http/operations";
import { defaultDocument } from "./dashboard-mutation";
import { localDashboardFacts } from "./dashboard-view";
import { editBodyPolicy } from "./dashboard";

const dashboardOperations = Schema.Literals([
  "dashboard.getDashboard",
  "dashboard.getDashboardView",
  "dashboard.listDashboardCatalog",
  "dashboard.initializeDashboard",
  "dashboard.applyDashboardEdit",
]);

export const isLocalDashboardOperation = Schema.is(dashboardOperations);

const documentJson = Schema.fromJsonString(Schema.toCodecJson(DashboardDocument));

const success = (data: Schema.Json): LocalMutationResult => ({
  status: 200,
  outcome: "success",
  body: { data, next: [] },
});

const missing: LocalMutationResult = {
  status: 404,
  outcome: "success",
  body: {
    error: {
      code: "dashboard_uninitialized",
      message: "Initialize your Dashboard explicitly, then read it again.",
    },
    next: [],
  },
};

const invalidEdit: LocalMutationResult = {
  status: 400,
  outcome: "validation_failed",
  body: {
    error: { code: "validation_failed", message: "Invalid Dashboard edit.", fields: [] },
    next: [],
  },
};

const missingWidget: LocalMutationResult = {
  status: 404,
  outcome: "not_found",
  body: { error: { code: "not_found", message: "Dashboard widget unavailable." }, next: [] },
};

const StoredDocument = Schema.Struct({ document_json: documentJson, revision: Schema.Int });

const findDocument = Effect.fn(function* (user: UserId) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT document_json,revision FROM user_documents WHERE user_id=${user} AND kind='dashboard'`;

  return row === undefined
    ? Option.none()
    : Option.some(yield* Schema.decodeUnknownEffect(StoredDocument)(row));
});

const editDocument = Effect.fn(function* (base: DashboardDocument, edit: DashboardEdit) {
  const result = yield* Effect.result(applyDashboardEdit({ document: base, edit }));

  if (Result.isFailure(result)) {
    return Result.fail(
      result.failure._tag === "WidgetNotFound" || result.failure._tag === "RegionNotFound"
        ? missingWidget
        : invalidEdit
    );
  }

  const categories = listLaunchCategories();

  const valid = collectDashboardCategoryReferences(result.success).every((ref) =>
    categories.some((category) => category.id === ref.categoryId)
  );

  return valid ? Result.succeed(result.success) : Result.fail(invalidEdit);
});

export const prepareDashboardDocument = Effect.fn(function* (
  user: UserId,
  stored: Option.Option<typeof StoredDocument.Type>,
  edit: Option.Option<DashboardEdit>
) {
  const sql = yield* SqliteClient;

  const base = Option.match(stored, {
    onNone: defaultDocument,
    onSome: (row) => row.document_json,
  });

  const result = Option.isSome(edit) ? yield* editDocument(base, edit.value) : Result.succeed(base);

  if (Result.isFailure(result)) return result.failure;
  const document = result.success;

  return prepareLocalWrite({
    targets: ["dashboard-document"],
    review: Effect.gen(function* () {
      return {
        revision: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
          revision: Option.isSome(stored) ? stored.value.revision : 0,
          document: Option.isSome(stored)
            ? yield* Schema.encodeEffect(documentJson)(stored.value.document_json)
            : null,
        }),
        effect: describeDashboardEffect({ edit, firstEdit: Option.isNone(stored) }),
      };
    }),
    commit: Effect.gen(function* () {
      if (Option.isNone(stored) || Option.isSome(edit)) {
        const encoded = yield* Schema.encodeEffect(documentJson)(document);
        const expected = Option.match(stored, { onNone: () => 0, onSome: (row) => row.revision });
        const revision = expected + (Option.isNone(stored) && Option.isSome(edit) ? 2 : 1);

        const written =
          yield* sql`INSERT INTO user_documents(user_id,kind,document_json,revision) VALUES(${user},'dashboard',${encoded},${revision})
      ON CONFLICT(user_id,kind) DO UPDATE SET document_json=excluded.document_json,revision=excluded.revision WHERE revision=${expected} RETURNING revision`;

        if (written.length !== 1) return yield* new DashboardUnavailable({ cause: undefined });
      }

      return success(yield* Schema.encodeEffect(Schema.toCodecJson(DashboardDocument))(document));
    }),
  });
});

const runDashboard = Effect.fn(function* (
  {
    operation,
    edit,
  }: { operation: typeof dashboardOperations.Type; edit: Option.Option<DashboardEdit> },
  user: UserId,
  current: number
) {
  if (operation === "dashboard.listDashboardCatalog") {
    const catalog = makeDashboardCatalog({ restaurantCategoryId: categoryIds.restaurantes });

    return success(yield* Schema.encodeEffect(Schema.toCodecJson(DashboardCatalog))(catalog));
  }

  const stored = yield* findDocument(user);

  if (
    operation === "dashboard.applyDashboardEdit" ||
    operation === "dashboard.initializeDashboard"
  ) {
    return yield* prepareDashboardDocument(user, stored, edit).pipe(
      Effect.flatMap(commitLocalWrite)
    );
  }

  if (Option.isNone(stored)) return missing;
  const document = stored.value.document_json;

  if (operation === "dashboard.getDashboard") {
    return success(yield* Schema.encodeEffect(Schema.toCodecJson(DashboardDocument))(document));
  }

  const now = DateTime.makeUnsafe(current);
  const facts = yield* localDashboardFacts(user, document, now);
  const view = yield* renderDashboardView({ document, facts, now });

  return success(yield* Schema.encodeEffect(Schema.toCodecJson(DashboardView))(view));
});

export const dispatchLocalDashboard = Effect.fn(
  function* (unit: {
    request: Request;
    storage: DurableObjectStorage;
    owns: (user: string) => boolean;
    operation: CatalogOperation;
  }) {
    const { request } = unit;
    const operation = yield* Schema.decodeUnknownEffect(dashboardOperations)(unit.operation.id);

    const input =
      operation === "dashboard.applyDashboardEdit"
        ? boundedJsonBody({
            request,
            policy: editBodyPolicy,
            schema: Schema.toCodecJson(DashboardEdit),
          }).pipe(Effect.map(Option.map((edit) => ({ operation, edit: Option.some(edit) }))))
        : Effect.succeed(
            new URL(request.url).search.length > 0
              ? Option.none()
              : Option.some({ operation, edit: Option.none<DashboardEdit>() })
          );

    return yield* runLocalMutation({ ...unit, input, work: runDashboard });
  },
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);

export const prepareLocalDashboard = Effect.fnUntraced(function* (
  user: UserId,
  edit: Option.Option<DashboardEdit>
) {
  return yield* findDocument(user).pipe(
    Effect.flatMap((stored) => prepareDashboardDocument(user, stored, edit))
  );
});

export const readDashboard = Effect.fnUntraced(function* (
  operation:
    | "dashboard.getDashboard"
    | "dashboard.getDashboardView"
    | "dashboard.listDashboardCatalog",
  user: UserId,
  current: number
) {
  return yield* runDashboard({ operation, edit: Option.none() }, user, current);
});
