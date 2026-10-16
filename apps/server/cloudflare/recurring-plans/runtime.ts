import { projections } from "./internal/erasure";
import { makeErasureStore } from "../erasure-store/runtime";
import type { ErasureStore } from "../erasure-store/contract";

export const makeRecurringPlansErasureStores = (db: D1Database): ReadonlyArray<ErasureStore> =>
  projections.map((projection) => makeErasureStore({ db, projection }));
