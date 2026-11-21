import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { deepStrictEqual } from "node:assert";
import { type Cause, Effect, Exit, Option, Predicate, Queue, Redacted, Terminal } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeRecoveryOperator } from "../../src/support-recovery/runtime";
import { RecoveryFailure } from "../../src/support-recovery/contract";

const native = it.layer(BunServices.layer, { excludeTestServices: true });

const noHttp = HttpClient.make((request) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ status: "approved" })))
);

const terminal = (readInput: Terminal.Terminal["readInput"]): Terminal.Terminal =>
  Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    size: Effect.acquireRelease(Queue.unbounded<Terminal.Size, Cause.Done>(), (queue) =>
      Queue.end(queue)
    ).pipe(Effect.tap((queue) => Queue.offer(queue, { columns: 80, rows: 24 }))),
    readInput,
    readLine: Effect.die("recovery must not use echoed line input"),
    display: () => Effect.die("recovery must not use stdout"),
  });

native((test) =>
  test.effect("hidden terminal entry restores its reader and never echoes proof characters", () =>
    Effect.gen(function* () {
      const events = yield* Queue.make<Terminal.UserInput>();
      const proof = "ABCDE-FGHJK-LMNPQ-RSTUV-WXYZ2";
      yield* Queue.offer(events, {
        input: Option.some(proof),
        key: { name: "", ctrl: false, meta: false, shift: false },
      });
      yield* Queue.offer(events, {
        input: Option.none(),
        key: { name: "return", ctrl: false, meta: false, shift: false },
      });
      let released = false;

      const release = Effect.sync(() => {
        released = true;
      });

      const input = Effect.addFinalizer(() => release).pipe(Effect.as(events));
      const output: Array<string> = [];

      const operator = yield* makeRecoveryOperator(noHttp, {
        interactive: true,
        write: (text) =>
          Effect.sync(() => {
            output.push(text);
          }),
      }).pipe(Effect.provideService(Terminal.Terminal, terminal(input)));

      expect(Redacted.value(yield* operator.readCode)).toBe(proof);
      expect(output.join("")).not.toContain(proof);
      expect(released).toBe(true);
    })
  )
);

const authenticate = Effect.fn(function* (tokenOutput: string) {
  const platform = yield* ChildProcessSpawner.ChildProcessSpawner;
  const children: Array<ChildProcessSpawner.ChildProcessHandle> = [];

  const replacement = ChildProcessSpawner.make((command) => {
    if (!Predicate.isTagged(command, "StandardCommand")) return Effect.die("unexpected pipeline");
    expect(command.command).toBe("cloudflared");
    const login = command.args[1] === "login";
    expect(command.args).toEqual(
      login
        ? ["access", "login", "--quiet", "https://api.fidyapp.com/internal/support-recovery"]
        : ["access", "token", "--app", "https://api.fidyapp.com/internal/support-recovery"]
    );

    return platform
      .spawn(
        ChildProcess.make(
          process.execPath,
          ["-e", login ? "process.exit(0)" : tokenOutput],
          command.options
        )
      )
      .pipe(
        Effect.tap((child) =>
          Effect.sync(() => {
            children.push(child);
          })
        )
      );
  });

  const operator = yield* makeRecoveryOperator(noHttp, {
    interactive: true,
    write: () => Effect.void,
  }).pipe(Effect.provideService(Terminal.Terminal, terminal(Effect.die("unused"))));

  const result = yield* operator.authenticate.pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, replacement),
    Effect.exit
  );

  yield* Effect.forEach(
    children,
    Effect.fnUntraced(function* (child) {
      expect(yield* child.isRunning).toBe(false);
    }),
    { discard: true }
  );

  return yield* result;
});

native((test) =>
  test.effect(
    "captures a scoped Access assertion without putting it in process arguments or output",
    () =>
      Effect.gen(function* () {
        const token = yield* authenticate("process.stdout.write('header.payload.signature')");
        expect(Redacted.value(token)).toBe("header.payload.signature");
      })
  )
);

native((test) =>
  test.effect(
    "cancelled or oversized hidden input releases the terminal without revealing proof",
    () =>
      Effect.forEach(
        [
          {
            input: Option.some("ABCDE-".repeat(6)),
            key: { name: "", ctrl: false, meta: false, shift: false },
          },
          {
            input: Option.none<string>(),
            key: { name: "c", ctrl: true, meta: false, shift: false },
          },
        ],
        Effect.fnUntraced(function* (event) {
          const events = yield* Queue.make<Terminal.UserInput>();
          yield* Queue.offer(events, event);
          let released = false;

          const release = Effect.sync(() => {
            released = true;
          });

          const input = Effect.addFinalizer(() => release).pipe(Effect.as(events));
          const output: Array<string> = [];

          const operator = yield* makeRecoveryOperator(noHttp, {
            interactive: true,
            write: (text) =>
              Effect.sync(() => {
                output.push(text);
              }),
          }).pipe(Effect.provideService(Terminal.Terminal, terminal(input)));

          const result = yield* operator.readCode.pipe(
            Effect.match({ onFailure: Exit.fail, onSuccess: Exit.succeed })
          );

          deepStrictEqual(
            result,
            Exit.fail(
              new RecoveryFailure({
                reason: event.key.ctrl ? "Cancelled" : "InvalidInput",
                cause: Option.none(),
              })
            )
          );
          expect(released).toBe(true);
          expect(output.join("")).not.toContain("ABCDE-");
        }),
        { discard: true }
      )
  )
);

native((test) =>
  test.effect(
    "rejects malformed or overflowing Access output as a closed authentication failure",
    () =>
      Effect.forEach(
        [
          "process.stdout.write('not a token')",
          "process.stdout.write('x'.repeat(9000));setInterval(() => {}, 1000)",
        ],
        Effect.fnUntraced(function* (script) {
          const result = yield* authenticate(script).pipe(
            Effect.match({ onFailure: Exit.fail, onSuccess: Exit.succeed })
          );

          deepStrictEqual(
            Exit.mapError(result, ({ reason }) => reason),
            Exit.fail("AccessUnavailable")
          );
        }),
        { discard: true }
      )
  )
);
