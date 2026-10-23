import type { AxeBuilder } from "@axe-core/playwright";

type Violation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];
type Node = Violation["nodes"][number];
type Appearance = { path: string; theme: string };

const hasApprovedColors = (data: unknown): boolean => {
  if (typeof data !== "object" || data === null) return false;
  return (
    "fgColor" in data &&
    data.fgColor === "#88cc20" &&
    "bgColor" in data &&
    data.bgColor === "#fae3d9" &&
    "expectedContrastRatio" in data &&
    data.expectedContrastRatio === "3:1"
  );
};

const isExactSloganNode = (node: Node): boolean =>
  node.target.length === 1 &&
  node.target[0] === "h1 > em" &&
  node.html === "<em>Tu vida, <br>más tranquila.</em>" &&
  node.all.length === 0 &&
  node.none.length === 0 &&
  node.any.length === 1;

// Design exception approved in #1524: this exact light slogan does NOT meet WCAG AA.
// Keep axe running on the entire document and retain every other failing node.
export const isAcceptedSloganContrast = (
  appearance: Appearance,
  rule: string,
  node: Node
): boolean =>
  appearance.path === "/" &&
  appearance.theme === "light" &&
  rule === "color-contrast" &&
  isExactSloganNode(node) &&
  node.any[0]?.id === "color-contrast" &&
  hasApprovedColors(node.any[0]?.data);

export const unexpectedViolations = (
  violations: Violation[],
  path: string,
  theme: string
): Violation[] =>
  violations
    .map((violation) => ({
      ...violation,
      nodes: violation.nodes.filter(
        (node) => !isAcceptedSloganContrast({ path, theme }, violation.id, node)
      ),
    }))
    .filter(({ nodes }) => nodes.length > 0);
