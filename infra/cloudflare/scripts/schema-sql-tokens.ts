/** Preserve SQL words, operators and quoted contents; ignore only comments and formatting.
 * Stored sqlite_master text can differ between SQLite engines without changing its SQL tokens.
 */
export const schemaSqlTokens = (sql: string): ReadonlyArray<string> => {
  const tokens: string[] = [];
  const lexer =
    /\s+|--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[\p{L}\p{N}_$]+|->>|->|<=|>=|<>|!=|==|<<|>>|\|\||[^\s]/guy;
  let offset = 0;
  while (offset < sql.length) {
    const match = lexer.exec(sql);
    if (match === null || match.index !== offset) throw Error("Invalid stored schema SQL");
    const token = match[0];
    offset = lexer.lastIndex;
    if (!/^\s|^--|^\/\*/u.test(token)) tokens.push(token);
  }
  return tokens;
};
