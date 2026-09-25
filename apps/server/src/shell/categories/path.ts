/** Canonical public path for Category discovery. */
export const listCategoriesPath = "/categories";

/** Canonical public path for the caller's own keyword rules. */
export const keywordRulesPath = "/category-keyword-rules";

/** Canonical public path template for one retained keyword rule. */
export const retainedKeywordRulePath = `${keywordRulesPath}/:id`;

/**
 * Whether a public path addresses the caller's keyword-rule family. The family prefix derives
 * from the one declared collection path, and the Worker treats a match as the stricter case,
 * so a new route under it inherits the browser-origin gate instead of escaping it.
 */
export const keywordRulePath = (path: string): boolean =>
  path === keywordRulesPath || path.startsWith(`${keywordRulesPath}/`);
