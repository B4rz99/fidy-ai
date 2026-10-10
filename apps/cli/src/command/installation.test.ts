import { Option } from "effect";
import { expect, it } from "vitest";
import { cliVersion, installationOutput } from "./installation";

it("publishes version and installation help without credential dependencies", () => {
  expect(installationOutput(["--version"])).toEqual(Option.some(`fidy ${cliVersion}\n`));
  expect(Option.getOrThrow(installationOutput(["--help"]))).toContain("fidy login");
  expect(Option.getOrThrow(installationOutput(["--help"]))).toContain("fidy --license");
});

it("publishes the Apple source-access notice at the same CLI release version", () => {
  const notice = Option.getOrThrow(installationOutput(["--license"]));
  expect(notice).toContain("Apple Public Source License 2.0");
  expect(notice).toContain(
    `https://github.com/B4rz99/fidy-ai/releases/download/cli-v${cliVersion}/fidy-cli-v${cliVersion}-source.tar.gz`
  );
  expect(notice).toContain("BUN-LICENSE.txt y THIRD-PARTY-NOTICES.txt");
  expect(
    Array.from(notice).every(
      (character) =>
        character === "\n" || (character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    )
  ).toBe(true);
});

it("does not intercept authenticated commands or mixed arguments", () => {
  for (const args of [
    [],
    ["login"],
    ["commands"],
    ["--help", "--json"],
    ["status", "--version"],
    ["--license", "--json"],
  ]) {
    expect(installationOutput(args)).toEqual(Option.none());
  }
});
