import type { Location, SourceCode } from "@oxlint/plugins";

/**
 * `loc` cut to the first line it covers. Oxlint prints every source line a diagnostic spans, so a
 * report on a whole function, loop, or call would print its entire body under the message.
 */
export function firstLineLoc(sourceCode: SourceCode, loc: Location): Location {
	if (loc.end.line === loc.start.line) return loc;
	const text = sourceCode.lines[loc.start.line - 1] ?? "";
	const column = Math.max(loc.start.column, text.trimEnd().length);
	return { start: loc.start, end: { line: loc.start.line, column } };
}
