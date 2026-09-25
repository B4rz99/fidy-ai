import { expect, it } from "@effect/vitest";
import { HttpApi } from "effect/unstable/httpapi";
import { MemoryGroup, memoryOperationIds } from "./operations";

const compareText = (left: string, right: string): number => left.localeCompare(right);

it("dispatches exactly the canonical operation ids the group declares", () => {
  const declared: Array<string> = [];
  HttpApi.reflect(HttpApi.make("memory").add(MemoryGroup), {
    onGroup: () => {},
    onEndpoint: ({ endpoint }) => {
      declared.push(`memory.${endpoint.identifier}`);
    },
  });
  expect([...memoryOperationIds].toSorted(compareText)).toEqual(declared.toSorted(compareText));
});
