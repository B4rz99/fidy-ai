// The behavioural source scope shared by the remaining core coverage and quality tools.
// Test harnesses and process wiring are intentionally outside the measured application source.
export const CORE_SRC = ["src/core"];

export const SHELL_SRC = ["src/shell"];

export const SOURCE_SRC = [...CORE_SRC, ...SHELL_SRC];

export const CORE_EXCLUDE = ["**/*.test.ts"];

export const SOURCE_EXCLUDE = [...CORE_EXCLUDE, "src/shell/testing/**"];
