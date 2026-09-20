import { createServer } from "node:net";
import { Effect } from "effect";

/**
 * Asks the operating system for an unused loopback TCP port, then releases the probe socket.
 * Callers must bind the returned port immediately. This removes cross-process collisions from
 * hand-maintained test ports while keeping the production runner address explicit.
 */
export const availableLoopbackPort: Effect.Effect<number> = Effect.callback<number>((resume) => {
  const server = createServer();
  server.unref();
  server.once("error", (error) => resume(Effect.die(error)));
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      resume(Effect.die("loopback port probe did not expose a TCP address"));
      return;
    }
    server.close((error) =>
      resume(error === undefined ? Effect.succeed(address.port) : Effect.die(error))
    );
  });
  return Effect.sync(() => {
    if (server.listening) server.close();
  });
});
