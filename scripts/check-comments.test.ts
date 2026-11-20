import { expect, test } from "bun:test";
import { compareComments, readBaseline } from "./check-comments";
import { commentsIn } from "./comment-syntax";

test.each([
  [
    "sample.tsx",
    'const label = "https://fidy.app";\nconst pattern = /\\/\\//;\n<div>{/* JSX */}</div>;',
    ["/* JSX */"],
  ],
  [
    "sample.astro",
    "---\n// Setup\n---\n<p>ó😀<!-- Markup --></p><script>// Script\n</script><style>a { color: /* CSS */ red; }</style>",
    ["// Setup", "<!-- Markup -->", "// Script", "/* CSS */"],
  ],
  [
    "sample.html",
    '<template><!-- Template --></template><script type="application/json">{"value":"// text"}</script><script>// JS\n</script>',
    ["<!-- Template -->", "// JS"],
  ],
  ["sample.css", 'a::before { content: "/* text */"; color: /* Value */ red; }', ["/* Value */"]],
  ["sample.jsonc", '{"url":"https://fidy.app","text":"/* text */"} // Config', ["// Config"]],
  [
    "sample.yaml",
    'body: | # Header\n  # Literal body\nvalue: "abc # quoted" # Inline\n',
    ["# Header", "# Inline"],
  ],
  [
    "sample.sh",
    "#!/bin/bash\necho '# literal ó😀' # Inline\ncat <<'END'\n# Literal body\nEND\n",
    ["# Inline"],
  ],
  ["sample.toml", 'value = "# literal" # Inline', ["# Inline"]],
  [
    "sample.sql",
    "SELECT '-- literal', [-- identifier]; /* SQL */ -- Inline",
    ["/* SQL */", "-- Inline"],
  ],
])("recognizes comment syntax in %s without flagging literals", (file, source, expected) => {
  expect(commentsIn({ file, source }).map(({ text }) => text)).toEqual(expected);
});

test("only the original occurrences at their original paths count against the baseline", () => {
  const text = "// Existing";
  const hash = new Bun.CryptoHasher("sha256").update(text).digest("base64url");
  const baseline = readBaseline(`"old.ts"\t${hash}\n"deleted.ts"\t${hash}\n`);
  const old = { file: "old.ts", line: 27, text };
  const duplicate = { ...old, line: 28 };
  const edited = { ...old, line: 29, text: "// Edited" };
  const copied = { ...old, file: "new.ts" };
  const reported = compareComments({ comments: [old, duplicate, edited, copied], baseline });

  expect(reported.added).toEqual([duplicate, edited, copied]);
  expect(reported.removed).toBe(1);
  expect([...reported.retained]).toEqual([["old.ts", [hash]]]);
});
