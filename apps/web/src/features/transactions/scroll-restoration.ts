import { useElementScrollRestoration, useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { useLayoutEffect, useRef, useState } from "react";

/** Router restoration can run before asynchronous continuation gives the ledger its height. */
export const useTransactionScrollRestoration = (ready: boolean): void => {
  const router = useRouter();
  const entry = useElementScrollRestoration({
    getElement: () => window,
    getKey: router.options.getScrollRestorationKey,
  });
  const [destination] = useState(() => Option.fromNullishOr(entry));
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (!ready || restored.current || Option.isNone(destination)) return;
    restored.current = true;
    window.scrollTo({
      top: destination.value.scrollY,
      left: destination.value.scrollX,
      behavior: "instant",
    });
  }, [ready, destination]);
};
