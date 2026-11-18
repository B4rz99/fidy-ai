import { expect, it } from "vitest";
import { edgeSecurityPolicy } from "./edge-security";
import { nativeEdgeChanges } from "./native-edge";

const latest = edgeSecurityPolicy.rulesets.customFirewall.rules.map((rule, index) => ({
  id: String(index).padStart(32, "0"),
  ref: "fidy-" + index,
  action: rule.action,
  expression: rule.expression,
  description: rule.description,
  enabled: rule.enabled,
  action_parameters: rule.actionParameters,
}));
const custom = (rules: ReadonlyArray<unknown>): unknown => ({
  id: "a".repeat(32),
  kind: "zone",
  phase: "http_request_firewall_custom",
  rules,
});

it("changes exactly the three owned host expressions and keeps all unrelated controls intact", () => {
  const previous = latest.map((rule) => ({
    ...rule,
    expression: rule.expression
      .replace(
        'http.host in {"api.fidyapp.com" "storage-acceptance.fidyapp.com"}',
        'http.host eq "api.fidyapp.com"'
      )
      .replace(' "storage-acceptance.fidyapp.com" "storage-web-acceptance.fidyapp.com"', ""),
  }));
  const changes = nativeEdgeChanges(custom(previous));
  expect(changes).toHaveLength(3);
  expect(changes.map((change) => change.body.expression)).toEqual(
    latest.slice(0, 3).map((rule) => rule.expression)
  );
  expect(changes[0]?.body.action_parameters).toEqual(latest[0]?.action_parameters);
  expect(nativeEdgeChanges(custom([latest[0], ...previous.slice(1)]))).toHaveLength(2);
  expect(nativeEdgeChanges(custom(latest))).toEqual([]);
  for (const rows of [
    [...latest].reverse(),
    latest.slice(1),
    [{ ...latest[0], enabled: false }, ...latest.slice(1)],
    [{ ...latest[0], expression: "true" }, ...latest.slice(1)],
    [{ ...latest[0], logging: { enabled: true } }, ...latest.slice(1)],
  ]) {
    expect(() => nativeEdgeChanges(custom(rows))).toThrow();
  }
});
