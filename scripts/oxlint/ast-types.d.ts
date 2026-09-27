import type { RuleTester } from "oxlint/plugins-dev";

// Derive node shapes from Oxlint's public RuleTester visitor API; do not maintain
// a parallel AST declaration for the JS plugin.
export type Rule = Parameters<RuleTester["run"]>[1];
type Visitors = ReturnType<NonNullable<Rule["create"]>>;
type VisitorNode<Key extends keyof Visitors> = Parameters<NonNullable<Visitors[Key]>>[0];

export type Node = VisitorNode<"MemberExpression">["parent"];
export type Program = VisitorNode<"Program">;
export type MemberExpression = VisitorNode<"MemberExpression">;
export type CallExpression = VisitorNode<"CallExpression">;
export type ArrowFunctionExpression = VisitorNode<"ArrowFunctionExpression">;
export type FunctionExpression = VisitorNode<"FunctionExpression">;
export type VariableDeclarator = VisitorNode<"VariableDeclarator">;
export type ImportDeclaration = VisitorNode<"ImportDeclaration">;
export type ExportNamedDeclaration = VisitorNode<"ExportNamedDeclaration">;
export type ImportSpecifier = VisitorNode<"ImportSpecifier">;
export type TSTypeAnnotation = VisitorNode<"TSTypeAnnotation">;
export type TSType = TSTypeAnnotation["typeAnnotation"];
export type TSTypeReference = VisitorNode<"TSTypeReference">;
export type TSTypeAliasDeclaration = VisitorNode<"TSTypeAliasDeclaration">;
export type TSInterfaceDeclaration = VisitorNode<"TSInterfaceDeclaration">;
export type TSInterfaceBody = VisitorNode<"TSInterfaceBody">;
export type TSTypeLiteral = VisitorNode<"TSTypeLiteral">;
export type TSIndexSignature = VisitorNode<"TSIndexSignature">;
export type TSParameterProperty = VisitorNode<"TSParameterProperty">;
export type Parameter = VisitorNode<"ArrowFunctionExpression">["params"][number];

export type TypeEnvironment = {
  aliases: Map<string, TSTypeAliasDeclaration>;
  interfaces: Map<string, Array<TSInterfaceDeclaration>>;
  shadowedBuiltIns: Set<string>;
};

export type Resolution = {
  environment: TypeEnvironment;
  substitutions: Map<string, TSType>;
  resolvingAliases: Set<string>;
};
