import { Data, type Redacted } from "effect";
import type { BackupRecoveryCode } from "@/transport/client";

type RotationVariants = {
  Idle: {};
  Reviewing: {};
  Rotating: {};
  Uncertain: {};
  Unauthenticated: {};
  Disposed: {};
  FreshSessionRequired: {};
};

export type RotationState = Data.TaggedEnum<
  RotationVariants & { Disclosed: { readonly copied: boolean } }
>;

export const RotationState = Data.taggedEnum<RotationState>();

export type DisclosureState = Data.TaggedEnum<
  RotationVariants & {
    Disclosed: { readonly code: Redacted.Redacted<BackupRecoveryCode>; readonly copied: boolean };
  }
>;

export const DisclosureState = Data.taggedEnum<DisclosureState>();
