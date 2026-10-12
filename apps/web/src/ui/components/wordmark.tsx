import type { JSX } from "react";
import { fidyLogoUrl } from "@/ui/brand";

export const FidyWordmark = (): JSX.Element => (
  <span className="inline-flex h-[54px] w-[94px] shrink-0 items-center justify-center overflow-hidden rounded-[11px] bg-black">
    <img className="h-auto w-[76px]" src={fidyLogoUrl} alt="Fidy" />
  </span>
);
