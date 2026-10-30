import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

export const onRequest = defineRouteMiddleware((context) => {
  const route = context.locals.starlightRoute;
  route.hasSidebar = true;
  if (route.id === "404") delete route.entry.data.hero;
});
