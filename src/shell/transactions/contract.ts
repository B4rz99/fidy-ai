import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import { CreateTransactionInput, Transaction, TransactionId } from "~/core/transactions/model";
import { Envelope } from "~/shell/_shared/envelope";
import { NotFound, Unauthenticated } from "~/shell/_shared/errors";

/**
 * The slice's canonical operations, defined once, here: paths, methods and
 * status codes over the core schemas. The HTTP server, the typed client, and
 * the OpenAPI spec are all derived from this definition.
 *
 * Every operation runs as somebody, so every operation can answer 401 — the
 * caller is resolved from the request, never named in a payload, which is why
 * no input schema here mentions a user (ARCHITECTURE.md §5).
 *
 * The 400 is absent from every `error` list and present on every operation
 * anyway: it is declared by the contract-gate middleware in `api.ts`, whose
 * error schema merges into each operation the middleware covers.
 *
 * An operation that routes a domain failure declares the whole wire union its
 * slice's mapper can return, because there is one mapper per slice and its
 * return type is that union (ARCHITECTURE.md §6). The alternative — a mapper
 * narrow enough per operation to keep each list minimal — is a mapper per
 * handler, which §6 rejects outright.
 *
 * Each operation carries an `OpenApi.Description`, and it is addressed to the
 * agent that will call it rather than to whoever maintains this file: the spec
 * these annotations land in derives the MCP tool definitions and the hosted
 * agent's toolkit, so this text is the manual a caller reads at runtime
 * (CODING_STANDARDS.md, agent-facing documentation).
 */
export const TransactionsGroup = HttpApiGroup.make("transactions").add(
  HttpApiEndpoint.post("createTransaction", "/transactions", {
    payload: CreateTransactionInput,
    success: Envelope(Transaction).pipe(HttpApiSchema.status(201)),
    error: [Unauthenticated, NotFound],
  }).annotate(
    OpenApi.Description,
    "Record one Transaction for the caller: a single exact movement of Money with its Currency, " +
      "direction, and merchant. Reach for this as soon as the user says money moved " +
      "and no record of it exists yet — money they spent, money that reached them, a receipt " +
      "they read out. The Transaction belongs to whoever the call is made as, so there is no " +
      "owner to name; the answer hands back the stored Transaction, id and all."
  ),
  HttpApiEndpoint.get("listTransactions", "/transactions", {
    success: Envelope(Schema.Array(Transaction)),
    error: Unauthenticated,
  }).annotate(
    OpenApi.Description,
    "Read back every Transaction the caller has recorded, most recent occurrence first. " +
      "Reach for this to answer anything about what the user spent or received — a total, a " +
      "merchant they keep paying, whether something was captured already. It takes no " +
      "filters and returns the whole history, so narrow it yourself. Somebody who has " +
      "recorded nothing gets an empty list, not a failure."
  ),
  HttpApiEndpoint.get("getTransaction", "/transactions/:id", {
    params: Schema.Struct({ id: TransactionId }),
    success: Envelope(Transaction),
    error: [Unauthenticated, NotFound],
  }).annotate(
    OpenApi.Description,
    "Fetch one Transaction of the caller's by id. Reach for this when you already hold an id " +
      "— from recording one, or from the history — and want the stored record rather than " +
      "what you remember of it. An id that belongs to another user answers exactly as an id " +
      "that never existed, so `not_found` never tells you the record is real elsewhere."
  )
);
