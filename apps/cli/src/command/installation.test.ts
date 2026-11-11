import { Option } from "effect";
import { expect, it } from "vitest";
import { installationOutput } from "./installation";

it("publishes installation help without credential dependencies", () => {
  expect(Option.getOrThrow(installationOutput(["--help"]))).toContain("fidy login");
});

it("does not intercept authenticated commands or mixed arguments", () => {
  for (const args of [[], ["login"], ["commands"], ["--help", "--json"], ["status", "--version"]]) {
    expect(installationOutput(args)).toEqual(Option.none());
  }
});
