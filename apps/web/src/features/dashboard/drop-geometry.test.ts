import { describe, expect, it } from "vitest";
import { widgetDropEdgeAt } from "./drop-geometry";

const rectangle = { top: 100, right: 500, bottom: 500, left: 100 };

const edgeAt = (horizontal: number, vertical: number): ReturnType<typeof widgetDropEdgeAt> =>
  widgetDropEdgeAt({ point: { horizontal, vertical }, rectangle });

describe("Widget drop geometry", () => {
  it.each([
    [300, 300, "center"],
    [120, 300, "left"],
    [480, 300, "right"],
    [300, 120, "top"],
    [300, 480, "bottom"],
  ] as const)("maps (%i, %i) to %s", (horizontal, vertical, expected) => {
    expect(edgeAt(horizontal, vertical)).toBe(expected);
  });

  it("uses the strongest direction in corner areas", () => {
    expect(edgeAt(110, 180)).toBe("left");
    expect(edgeAt(180, 110)).toBe("top");
  });
});
