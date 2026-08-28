import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

const cliPath = new URL("../../../scripts/support-recovery.ts", import.meta.url).pathname;
const pairingCode = "ABCD-EFGH";
const recoveryCode = "ABCDE-FGHIJ-KLMNO-PQRST-UVWXY";
const oversizedRecoveryInput = `${recoveryCode}12345678901234567890`;
const boundedRecoveryInput = oversizedRecoveryInput.slice(0, 40);
const ignoredArgumentSecret = "argv-secret-must-not-be-read";
const ignoredEnvironmentSecret = "environment-secret-must-not-be-read";

const makeFixture = Effect.fn("SupportRecoveryCliTest.makeFixture")(function* (input: {
  response: "approved" | "not_approved" | "limited" | "unavailable";
  cloudflaredExit: number;
}) {
  const directory = yield* Effect.promise(() =>
    Bun.$`mktemp -d`.text().then((text) => text.trim())
  );
  const cloudflaredLog = `${directory}/cloudflared.log`;
  const requestLog = `${directory}/request.json`;
  const preloadPath = `${directory}/preload.ts`;
  const cloudflaredPath = `${directory}/cloudflared`;
  const driverPath = `${directory}/run.py`;
  const response =
    input.response === "limited"
      ? { status: "limited", message: "Demasiados intentos.", retryAfterSeconds: 7 }
      : { status: input.response, message: "Resultado cerrado." };
  const encodedRequestLog = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(requestLog);
  const encodedCloudflaredLog = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(
    cloudflaredLog
  );
  const encodedResponse = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(response);
  const encodedResponseLiteral = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(
    encodedResponse
  );
  const driverConfiguration = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
    command: [
      "bun",
      "--preload",
      preloadPath,
      cliPath,
      "--backup-recovery-code",
      ignoredArgumentSecret,
    ],
    path: `${directory}:${Bun.env.PATH ?? ""}`,
    environmentSecret: ignoredEnvironmentSecret,
    prompts:
      input.cloudflaredExit === 0
        ? [
            ["Referencia pública de vinculación: ", `${pairingCode}\r`],
            ["Código de recuperación (entrada oculta): ", `${oversizedRecoveryInput}\r`],
          ]
        : [],
  });
  const encodedDriverConfiguration = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(
    driverConfiguration
  );
  yield* Effect.promise(() =>
    Promise.all([
      Bun.write(
        preloadPath,
        `globalThis.fetch = async (request, init) => {\n` +
          `  const value = request instanceof Request ? request : new Request(request, init);\n` +
          `  await Bun.write(${encodedRequestLog}, value.headers.get("cf-access-token") + "\\n" + await value.clone().text());\n` +
          `  return new Response(${encodedResponseLiteral}, { status: 200, headers: { "content-type": "application/json" } });\n` +
          `};\n`
      ),
      Bun.write(
        cloudflaredPath,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> ${encodedCloudflaredLog}\n` +
          `if [ "$2" = "token" ]; then printf 'fixture-access-token'; fi\n` +
          `exit ${input.cloudflaredExit}\n`
      ),
      Bun.write(
        driverPath,
        `#!/usr/bin/env python3\n` +
          `import json, os, pty, select, signal, sys, time\n` +
          `configuration = json.loads(${encodedDriverConfiguration})\n` +
          `child_pid, terminal_fd = pty.fork()\n` +
          `if child_pid == 0:\n` +
          `    environment = os.environ.copy()\n` +
          `    environment["PATH"] = configuration["path"]\n` +
          `    environment["SUPPORT_RECOVERY_CODE"] = configuration["environmentSecret"]\n` +
          `    os.execvpe("bun", configuration["command"], environment)\n` +
          `output = bytearray()\n` +
          `prompts = [[prompt.encode(), answer.encode()] for prompt, answer in configuration["prompts"]]\n` +
          `deadline = time.monotonic() + 15\n` +
          `while time.monotonic() < deadline:\n` +
          `    ready, _, _ = select.select([terminal_fd], [], [], 0.1)\n` +
          `    if ready:\n` +
          `        try:\n` +
          `            chunk = os.read(terminal_fd, 4096)\n` +
          `        except OSError:\n` +
          `            break\n` +
          `        if not chunk:\n` +
          `            break\n` +
          `        output.extend(chunk)\n` +
          `        if prompts and prompts[0][0] in output:\n` +
          `            _, answer = prompts.pop(0)\n` +
          `            os.write(terminal_fd, answer)\n` +
          `    finished_pid, status = os.waitpid(child_pid, os.WNOHANG)\n` +
          `    if finished_pid:\n` +
          `        sys.stdout.buffer.write(output)\n` +
          `        sys.exit(os.waitstatus_to_exitcode(status))\n` +
          `else:\n` +
          `    os.kill(child_pid, signal.SIGKILL)\n` +
          `_, status = os.waitpid(child_pid, 0)\n` +
          `sys.stdout.buffer.write(output)\n` +
          `sys.exit(os.waitstatus_to_exitcode(status))\n`
      ),
    ]).then(() => Bun.$`chmod +x ${cloudflaredPath} ${driverPath}`.quiet())
  );
  return { directory, cloudflaredLog, requestLog, preloadPath, driverPath };
});

const runFixture = Effect.fn("SupportRecoveryCliTest.runFixture")(function* (fixture: {
  directory: string;
  cloudflaredLog: string;
  requestLog: string;
  driverPath: string;
}) {
  const child = Bun.spawn([fixture.driverPath], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = yield* Effect.promise(() =>
    Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
  );
  return { stdout, stderr, exitCode };
});

it.effect("authenticates before hidden bounded input without exposing credentials", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({ response: "approved", cloudflaredExit: 0 });
    const result = yield* runFixture(fixture);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Recuperación aprobada.");
    expect(result.stdout).not.toContain("Resultado cerrado.");
    expect(`${result.stdout}${result.stderr}`).not.toContain(boundedRecoveryInput);
    expect(`${result.stdout}${result.stderr}`).not.toContain(ignoredArgumentSecret);
    expect(`${result.stdout}${result.stderr}`).not.toContain(ignoredEnvironmentSecret);
    const cloudflaredArguments = yield* Effect.promise(() =>
      Bun.file(fixture.cloudflaredLog).text()
    );
    expect(cloudflaredArguments).toContain("access login");
    expect(cloudflaredArguments).toContain("access token");
    expect(cloudflaredArguments).not.toContain(boundedRecoveryInput);
    expect(cloudflaredArguments).not.toContain(ignoredArgumentSecret);
    expect(cloudflaredArguments).not.toContain(ignoredEnvironmentSecret);
    const [accessToken, requestBody] = (yield* Effect.promise(() =>
      Bun.file(fixture.requestLog).text()
    )).split("\n", 2);
    expect(accessToken).toBe("fixture-access-token");
    expect(
      yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({ pairingCode: Schema.String, backupRecoveryCode: Schema.String })
        )
      )(requestBody)
    ).toEqual({ pairingCode, backupRecoveryCode: boundedRecoveryInput });
    expect(requestBody).not.toContain(ignoredArgumentSecret);
    expect(requestBody).not.toContain(ignoredEnvironmentSecret);
  })
);

it.effect("accepts exactly bounded stdin without echo and rejects oversized stdin", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({ response: "approved", cloudflaredExit: 0 });
    const child = Bun.spawn(["bun", "--preload", fixture.preloadPath, cliPath], {
      env: { PATH: `${fixture.directory}:${Bun.env.PATH ?? ""}` },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    yield* Effect.promise(() =>
      Promise.resolve(child.stdin.write(`${pairingCode}\n${recoveryCode}\n`))
    );
    yield* Effect.promise(() => Promise.resolve(child.stdin.end()));
    const [stdout, stderr, exitCode] = yield* Effect.promise(() =>
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Recuperación aprobada.");
    expect(`${stdout}${stderr}`).not.toContain(recoveryCode);
    expect(yield* Effect.promise(() => Bun.file(fixture.requestLog).text())).toContain(
      recoveryCode
    );
    expect(yield* Effect.promise(() => Bun.file(fixture.cloudflaredLog).text())).toContain(
      "access token"
    );

    const oversizedFixture = yield* makeFixture({ response: "approved", cloudflaredExit: 0 });
    const oversizedChild = Bun.spawn(["bun", "--preload", oversizedFixture.preloadPath, cliPath], {
      env: { PATH: `${oversizedFixture.directory}:${Bun.env.PATH ?? ""}` },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    yield* Effect.promise(() =>
      Promise.resolve(
        oversizedChild.stdin.write(`${pairingCode}\n${oversizedRecoveryInput.repeat(2)}\n`)
      )
    );
    yield* Effect.promise(() => Promise.resolve(oversizedChild.stdin.end()));
    const [oversizedOutput, oversizedExit] = yield* Effect.promise(() =>
      Promise.all([new Response(oversizedChild.stderr).text(), oversizedChild.exited])
    );
    expect(oversizedExit).toBe(1);
    expect(oversizedOutput).toContain("La operación de soporte no está disponible.");
    expect(oversizedOutput).not.toContain(oversizedRecoveryInput);
    expect(yield* Effect.promise(() => Bun.file(oversizedFixture.requestLog).exists())).toBe(false);
  })
);

it.effect("fails closed before prompting when Access authentication fails", () =>
  Effect.gen(function* () {
    const fixture = yield* makeFixture({ response: "approved", cloudflaredExit: 1 });
    const result = yield* runFixture(fixture);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain("Referencia pública");
    expect(`${result.stdout}${result.stderr}`).toContain(
      "La operación de soporte no está disponible."
    );
    expect(yield* Effect.promise(() => Bun.file(fixture.requestLog).exists())).toBe(false);
  })
);

it.effect("uses closed output and distinct refusal and retry exit statuses", () =>
  Effect.gen(function* () {
    const refusal = yield* makeFixture({ response: "not_approved", cloudflaredExit: 0 }).pipe(
      Effect.flatMap(runFixture)
    );
    const limited = yield* makeFixture({ response: "limited", cloudflaredExit: 0 }).pipe(
      Effect.flatMap(runFixture)
    );
    expect(refusal.exitCode).toBe(2);
    expect(refusal.stdout).toContain("No pudimos aprobar la recuperación.");
    expect(refusal.stdout).not.toContain("Resultado cerrado.");
    expect(limited.exitCode).toBe(1);
    expect(limited.stdout).toContain("La operación de soporte no está disponible.");
    expect(`${limited.stdout}${limited.stderr}`).toContain("Reintenta en 7 segundos.");
    expect(`${refusal.stdout}${refusal.stderr}${limited.stdout}${limited.stderr}`).not.toMatch(
      /SqlError|Cause|backupRecoveryCode|credential/gu
    );
  })
);
