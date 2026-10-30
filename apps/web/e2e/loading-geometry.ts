import { dual } from "effect/Function";
import type { Page } from "@playwright/test";
import { playwright } from "./playwright-runtime";

const { expect } = playwright;
type FramePart = Readonly<{ name: string; selector: string }>;
type Geometry = Readonly<{ name: string; x: number; y: number; width: number }>;

export const measureLoadingFrame: {
  (parts: ReadonlyArray<FramePart>): (page: Page) => Promise<ReadonlyArray<Geometry>>;
  (page: Page, parts: ReadonlyArray<FramePart>): Promise<ReadonlyArray<Geometry>>;
} = dual(2, (page: Page, parts: ReadonlyArray<FramePart>): Promise<ReadonlyArray<Geometry>> =>
  Promise.all(
    parts.map(({ name, selector }) =>
      page
        .locator(selector)
        .first()
        .evaluate((element, part) => {
          const bounds = element.getBoundingClientRect();
          return { name: part, x: bounds.x, y: bounds.y, width: bounds.width };
        }, name)
    )
  )
);

export const expectSameLoadingFrame: {
  (loaded: ReadonlyArray<Geometry>): (loading: ReadonlyArray<Geometry>) => void;
  (loading: ReadonlyArray<Geometry>, loaded: ReadonlyArray<Geometry>): void;
} = dual(2, (loading: ReadonlyArray<Geometry>, loaded: ReadonlyArray<Geometry>): void => {
  expect(loaded.map((part) => part.name)).toEqual(loading.map((part) => part.name));
  for (const [index, before] of loading.entries()) {
    const after = loaded[index];
    expect(after).toBeDefined();
    if (after === undefined) continue;
    const maximumShiftPixels = 1;
    for (const axis of ["x", "y", "width"] as const) {
      expect(Math.abs(before[axis] - after[axis]), `${before.name} ${axis}`).toBeLessThanOrEqual(
        maximumShiftPixels
      );
    }
  }
});
