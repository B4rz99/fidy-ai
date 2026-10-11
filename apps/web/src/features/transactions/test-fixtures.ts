import { Option, Schema } from "effect";
import { Category, Transaction, User } from "@/transport/client";
import { type Model, initialModel } from "./model";

export const category = Schema.decodeSync(Category)({
  id: "24000000-0000-4000-8000-000000000001",
  label: "Mercado",
});
export const user = Schema.decodeSync(User)({
  id: "24000000-0000-4000-8000-000000000003",
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: "America/Bogota",
  trialPeriod: { startedAt: "2026-01-01T00:00:00Z", endsAt: "2026-01-08T00:00:00Z" },
  createdAt: "2026-01-01T00:00:00Z",
});
export const record = Schema.decodeSync(Transaction)({
  id: "24000000-0000-4000-8000-000000000002",
  categoryId: category.id,
  revision: 3,
  money: { amount: "25000", currency: "COP" },
  direction: "outflow",
  counterparty: "Árbol",
  notes: "Compra semanal",
  occurredAt: "2026-10-09T02:30:00Z",
  createdAt: "2026-10-09T12:30:00Z",
});
export const ready: Model = {
  ...initialModel,
  query: {
    ...initialModel.query,
    user: Option.some(user),
    transactions: [record],
    categories: [category],
    timeZone: user.timeZone,
    status: "Ready",
    waiting: false,
  },
};
