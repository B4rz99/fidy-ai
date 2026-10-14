export const CORE_SRC = ["src/core"];

export const SHELL_SRC = ["src/shell"];

export const SOURCE_SRC = [...CORE_SRC, ...SHELL_SRC];

export const CORE_EXCLUDE = ["**/*.test.ts"];

export const SOURCE_EXCLUDE = [...CORE_EXCLUDE, "src/shell/testing/**", "**/*.test-fixture.ts"];
