/** Preserve SQL words, operators and quoted contents; ignore only comments and formatting.
 * Stored sqlite_master text can differ between SQLite engines without changing its SQL tokens.
 */
export const schemaSqlTokens = (sql: string): ReadonlyArray<string> => {
  const tokens: string[] = [];
  const lexer =
    /[ \t\v\f\r\n]+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z0-9_$\u0080-\uFFFF]+|->>|->|<=|>=|<>|!=|==|<<|>>|\|\||[^\s]/gy;
  let offset = 0;
  while (offset < sql.length) {
    const match = lexer.exec(sql);
    if (match === null || match.index !== offset) throw Error("Invalid stored schema SQL");
    const token = match[0];
    offset = lexer.lastIndex;
    if (!/^[ \t\v\f\r\n]|^--|^\/\*/u.test(token)) tokens.push(token);
  }
  return tokens;
};
