import type { Miniflare } from "miniflare";
import type { FinancialFixtureOwner } from "../reference/native-seed";
import type { d1Platform } from "./d1.mjs";

export type Database = Awaited<ReturnType<Miniflare["getD1Database"]>>;
export type D1 = Awaited<ReturnType<typeof d1Platform>>;
export type Owner = FinancialFixtureOwner;
export type Pair = { pairingId: string; privateVerifier: string; publicCode: string };
export type Subject = {
  id: string;
  index: number;
  caller: string;
  owner: Owner;
  expectedCounts: Record<string, number> & { currencies: number };
  headers: Record<string, string>;
  state:
    | { kind: "seeded" }
    | {
        kind: "warm";
        initial: {
          data: readonly { id: string; revision: number; counterparty: string }[];
          next: unknown;
        };
        digest: string;
        before: Record<string, number>;
      };
};
export type Platform = {
  runtime: Miniflare;
  subjects: Subject[];
  approve: (subject: Subject, pair: Pair) => Promise<void>;
};
export type Platforms = Record<string, Platform>;
export type Caller = { runtime: Miniflare; subject: Subject };
export type RequestOptions = Partial<{
  method: string;
  body: string;
  headers: Record<string, string>;
}>;
export type Call = (
  path: string,
  options?: RequestOptions
) => Promise<{ status: number; body: unknown }>;
export type Offer = { user: number; sample: number; variant: string; cell: string };
export type Mutation = { user: number; sample: number; variant: string; financialUser: number };
export type Journey = (caller: Caller, row: Mutation) => Promise<void>;
export type Counts = {
  reads: (user: number) => number;
  corrections: (user: number) => number;
  rejections: (user: number) => number;
};
export type SpanCall = Omit<Offer, "variant"> & { traces: ReturnType<Headers["get"]>[] };
