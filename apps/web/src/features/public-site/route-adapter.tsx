import { useLocation } from "@tanstack/react-router";
import { type JSX, type RefCallback, useCallback } from "react";
import { mountElementProgram } from "@/browser/element-program";
import { mountPublicSite } from "./native/program";

export const PublicPage = (): JSX.Element => {
  const page = useLocation({ select: (location) => location.pathname });
  const mount = useCallback<RefCallback<HTMLDivElement>>(
    (host) =>
      host === null
        ? undefined
        : mountElementProgram({
            host,
            mount: (container) => mountPublicSite({ container, page, headOwnership: "Feature" }),
          }),
    [page]
  );
  return <div id="public-site" key={page} ref={mount} />;
};
