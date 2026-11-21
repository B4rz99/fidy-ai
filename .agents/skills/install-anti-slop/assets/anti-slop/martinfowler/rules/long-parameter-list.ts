import { defineRule, type ESTree } from "@oxlint/plugins";

import {
	functionName,
	type FunctionNode,
	functionReportLoc,
	isIgnoredTestFile,
	namedSubject,
	numberOption,
} from "../shared.ts";

const defaultMax = 4;

function isPositional(parameter: ESTree.Node): boolean {
	if (parameter.type === "RestElement") return false;
	if (parameter.type === "Identifier" && parameter.name === "this") return false;
	return true;
}

/** Flag function implementations with more positional parameters than the configured maximum. */
export const longParameterListRule = defineRule({
	meta: {
		type: "suggestion",
		docs: {
			description:
				"Flag functions with more positional parameters than a threshold (Refactoring, Long Parameter List).",
		},
		messages: {
			long: "Long parameter list{{subject}}: {{count}} positional parameters (limit {{max}}). Pass one parameter object.",
		},
		schema: [
			{
				type: "object",
				properties: { ignoreTests: { type: "boolean" }, max: { type: "integer", minimum: 0 } },
				additionalProperties: false,
			},
		],
		defaultOptions: [{ ignoreTests: true, max: defaultMax }],
	},
	createOnce(context) {
		const check = (node: FunctionNode) => {
			if (node.body === null || node.body === undefined) return;
			const max = numberOption(context.options, "max", defaultMax);
			const count = node.params.filter(isPositional).length;
			if (count <= max) return;
			context.report({
				loc: functionReportLoc(node, context.sourceCode),
				messageId: "long",
				data: {
					subject: namedSubject(functionName(node, context.sourceCode)),
					count,
					max,
				},
			});
		};
		return {
			before() {
				return isIgnoredTestFile(context) ? false : undefined;
			},
			FunctionDeclaration: check,
			FunctionExpression: check,
			ArrowFunctionExpression: check,
		};
	},
});
