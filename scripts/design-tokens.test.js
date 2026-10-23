import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("../design/tokens.css", import.meta.url), "utf8");
const tokens = new Map(
  [...css.matchAll(/(--[\w-]+):\s*([^;]+);/gu)].map((match) => [match[1], match[2]])
);
const color = (name, theme) => {
  let value = tokens.get(`--fidy-${name}`);
  assert.ok(value, `Missing ${name}`);
  value = value.replace(/var\(--fidy-([\w-]+)\)/gu, (_, key) => color(key, theme));
  const pair = /^light-dark\(([^,]+),\s*([^)]+)\)$/u.exec(value);
  return pair ? pair[theme === "light" ? 1 : 2].trim() : value;
};
const luminance = (hex) => {
  const channels = hex
    .slice(1)
    .match(/../gu)
    .map((channel) => {
      const value = Number.parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
};
const contrast = (foreground, background) => {
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
};
for (const theme of ["light", "dark"]) {
  test(`${theme}: primary remains the approved lime and all button states have readable labels`, () => {
    assert.equal(color("button-primary-default-background", theme), "#88cc20");
    for (const state of ["default", "hover", "pressed"]) {
      assert.ok(
        contrast(
          color(`button-primary-${state}-foreground`, theme),
          color(`button-primary-${state}-background`, theme)
        ) >= 4.5
      );
    }
    assert.ok(
      contrast(
        color("button-disabled-foreground", theme),
        color("button-disabled-background", theme)
      ) >= 4.5
    );
  });
  test(`${theme}: semantic messages remain readable on their paired fills and base surfaces`, () => {
    for (const state of ["success", "warning", "error", "info"]) {
      const foreground = color(`semantic-${state}-foreground`, theme);
      for (const background of [
        `semantic-${state}-subtle-background`,
        "background-canvas",
        "background-surface",
        "background-raised",
      ]) {
        assert.ok(
          contrast(foreground, color(background, theme)) >= 4.5,
          `${state} on ${background}`
        );
      }
    }
  });
  test(`${theme}: controls and focus are distinguishable on supported surfaces`, () => {
    for (const surface of ["background-canvas", "background-surface", "background-raised"]) {
      assert.ok(contrast(color("border-control", theme), color(surface, theme)) >= 3);
      assert.ok(contrast(color("focus-ring-color", theme), color(surface, theme)) >= 3);
      assert.ok(
        contrast(color("button-primary-default-border", theme), color(surface, theme)) >= 3
      );
    }
  });
}
