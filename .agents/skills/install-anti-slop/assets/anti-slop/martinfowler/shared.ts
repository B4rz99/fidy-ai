import type { Context, ESTree, Location, Options, Scope, SourceCode, Variable } from "@oxlint/plugins";

import { firstLineLoc } from "../shared/report-location.ts";

type JsonValue = Options[number];
type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

type WrapperNode =
	| ESTree.ParenthesizedExpression
	| ESTree.TSAsExpression
	| ESTree.TSSatisfiesExpression
	| ESTree.TSTypeAssertion
	| ESTree.TSNonNullExpression
	| ESTree.ChainExpression;

export type { FunctionNode };

function optionValue(options: Readonly<Options> | undefined, key: string): JsonValue | undefined {
	const first = options?.[0];
	if (typeof first !== "object" || first === null || Array.isArray(first)) return undefined;
	return first[key];
}

export function numberOption(
	options: Readonly<Options> | undefined,
	key: string,
	fallback: number,
): number {
	const value = optionValue(options, key);
	return typeof value === "number" ? value : fallback;
}

export function booleanOption(
	options: Readonly<Options> | undefined,
	key: string,
	fallback: boolean,
): boolean {
	const value = optionValue(options, key);
	return typeof value === "boolean" ? value : fallback;
}

export function stringListOption(
	options: Readonly<Options> | undefined,
	key: string,
	fallback: ReadonlyArray<string>,
): ReadonlyArray<string> {
	const value = optionValue(options, key);
	if (!Array.isArray(value)) return fallback;
	return value.filter((item): item is string => typeof item === "string");
}

const testFilePattern =
	/(?:^|[\\/])(?:__tests__|__mocks__|test|tests)[\\/]|\.(?:test|spec)\.[cm]?[jt]sx?$/;

export function isTestFile(filename: string): boolean {
	return testFilePattern.test(filename);
}

/** Test files follow different size and setup conventions, so rules skip them unless `ignoreTests: false`. */
export function isIgnoredTestFile(context: Context): boolean {
	return booleanOption(context.options, "ignoreTests", true) && isTestFile(context.filename);
}

export function isFunctionNode(node: ESTree.Node): node is FunctionNode {
	return (
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression" ||
		node.type === "ArrowFunctionExpression"
	);
}

/** Strip parentheses, TypeScript-only wrappers, and optional-chain wrappers. */
export function unwrap(node: ESTree.Expression): ESTree.Expression {
	let current = node;
	while (
		current.type === "ParenthesizedExpression" ||
		current.type === "TSAsExpression" ||
		current.type === "TSSatisfiesExpression" ||
		current.type === "TSTypeAssertion" ||
		current.type === "TSNonNullExpression" ||
		current.type === "ChainExpression"
	) {
		current = current.expression;
	}
	return current;
}

export function isWrapper(node: ESTree.Node | null): node is WrapperNode {
	return (
		node !== null &&
		(node.type === "ParenthesizedExpression" ||
			node.type === "TSAsExpression" ||
			node.type === "TSSatisfiesExpression" ||
			node.type === "TSTypeAssertion" ||
			node.type === "TSNonNullExpression" ||
			node.type === "ChainExpression")
	);
}

function isNode(value: unknown): value is ESTree.Node {
	return (
		typeof value === "object" &&
		value !== null &&
		"type" in value &&
		typeof value.type === "string"
	);
}

/** Direct AST children, excluding the `parent` back-reference. */
export function childNodes(node: ESTree.Node): ReadonlyArray<ESTree.Node> {
	const children: Array<ESTree.Node> = [];
	for (const [key, value] of Object.entries(node)) {
		if (key === "parent") continue;
		if (Array.isArray(value)) {
			for (const item of value) if (isNode(item)) children.push(item);
		} else if (isNode(value)) {
			children.push(value);
		}
	}
	return children;
}

export function contains(outer: ESTree.Node, inner: ESTree.Node): boolean {
	return outer.range[0] <= inner.range[0] && inner.range[1] <= outer.range[1];
}

export function lineSpan(node: ESTree.Node): number {
	return node.loc.end.line - node.loc.start.line + 1;
}

/** Resolve an identifier to its binding by walking lexical scopes upward. */
export function resolveVariable(
	sourceCode: SourceCode,
	identifier: ESTree.Node & { readonly name: string },
): Variable | null {
	let scope: Scope | null = sourceCode.getScope(identifier);
	while (scope !== null) {
		const variable = scope.set.get(identifier.name);
		if (variable !== undefined) return variable;
		scope = scope.upper;
	}
	return null;
}

function labelArgument(call: ESTree.CallExpression): ESTree.Node | undefined {
	const first = call.arguments[0];
	if (first === undefined) return undefined;
	if (first.type === "Literal" && typeof first.value === "string") return first;
	if (first.type === "TemplateLiteral" && first.expressions.length === 0) return first;
	return undefined;
}

function isEffectConstructor(callee: ESTree.Expression): boolean {
	return (
		callee.type === "MemberExpression" &&
		!callee.computed &&
		callee.property.type === "Identifier" &&
		["fn", "fnUntraced", "gen"].includes(callee.property.name)
	);
}

/** The binding, key, or assignment target that names `holder`, the expression `parent` holds. */
function holderNameNode(holder: ESTree.Node, parent: ESTree.Node | null): ESTree.Node | undefined {
	if (parent === null) return undefined;
	if (parent.type === "VariableDeclarator") return parent.id.type === "Identifier" ? parent.id : undefined;
	if (
		parent.type === "MethodDefinition" ||
		parent.type === "Property" ||
		parent.type === "PropertyDefinition"
	) {
		return parent.key;
	}
	if (parent.type === "AssignmentExpression" && parent.right === holder) return parent.left;
	return undefined;
}

/**
 * The node that names a function: its own id, the `Effect.fn("name")` label, or the binding,
 * property key, or assignment target that holds it, also through `Effect.fn`/`Effect.gen` calls
 * (so `make: Effect.gen(function* ...)` is named by `make`). Undefined for anonymous callbacks.
 */
export function functionNameNode(node: FunctionNode): ESTree.Node | undefined {
	if (node.type !== "ArrowFunctionExpression" && node.id !== null && node.id !== undefined) {
		return node.id;
	}
	let holder: ESTree.Node = node;
	let parent = node.parent;
	while (isWrapper(parent)) {
		holder = parent;
		parent = parent.parent;
	}
	if (parent.type !== "CallExpression" || parent.callee === holder) return holderNameNode(holder, parent);
	const callee = unwrap(parent.callee);
	if (callee.type === "CallExpression") {
		const label = labelArgument(callee);
		if (label !== undefined) return label;
	}
	if (!isEffectConstructor(callee.type === "CallExpression" ? unwrap(callee.callee) : callee)) {
		return undefined;
	}
	let outer: ESTree.Node = parent;
	let above: ESTree.Node | null = parent.parent;
	while (above?.type === "CallExpression" || isWrapper(above)) {
		outer = above;
		above = above.parent;
	}
	return holderNameNode(outer, above);
}

function isComputedKey(name: ESTree.Node): boolean {
	const parent = name.parent;
	return (
		parent !== null &&
		(parent.type === "MethodDefinition" ||
			parent.type === "Property" ||
			parent.type === "PropertyDefinition") &&
		parent.key === name &&
		parent.computed
	);
}

/** Name a function from its own id or the binding, key, or `Effect.fn("name")` that holds it. */
export function functionName(node: FunctionNode, sourceCode: SourceCode): string | undefined {
	const name = functionNameNode(node);
	if (name === undefined || isComputedKey(name)) return undefined;
	if (name.type === "Identifier") return name.name;
	if (name.type === "PrivateIdentifier") return `#${name.name}`;
	if (name.type === "Literal") return typeof name.value === "string" ? name.value : undefined;
	if (name.type === "TemplateLiteral") return name.quasis[0]?.value.cooked ?? undefined;
	return sourceCode.getText(name);
}

/** Where to report a function: its name when it has one, otherwise the function's first line. */
export function functionReportLoc(node: FunctionNode, sourceCode: SourceCode): Location {
	return firstLineLoc(sourceCode, (functionNameNode(node) ?? node).loc);
}

/** `` `name` `` after a smell name in a message, or nothing for an anonymous function. */
export function namedSubject(name: string | undefined): string {
	return name === undefined ? "" : ` \`${name}\``;
}

export function truncate(text: string, max = 80): string {
	const compact = text.replace(/\s+/g, " ");
	return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}
