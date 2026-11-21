import { expect, it } from "vitest";
import { Option, Schema } from "effect";
import { CategoryTaxonomyRelease, categoryIds } from "~/core/categories/contract";
import {
  compatibleCategoryReleases,
  currentCategoryRelease,
  interpretCategory,
} from "~/core/categories/operations";

it("requires reader support before writing a new revision and preserves the exact older definition", () => {
  const original = currentCategoryRelease.revisions[0];

  if (original === undefined) throw new Error("Missing initial taxonomy");

  const changed = {
    id: "co-2",
    categories: [
      ...original.categories
        .toReversed()
        .map((category) =>
          category.id === categoryIds.mercado ? { ...category, label: "Alimentos" } : category
        ),
      { id: "20000000-0000-4000-8000-000000000017", label: "Prueba" },
    ],
  };

  const prepared = Schema.decodeSync(CategoryTaxonomyRelease)({
    write: original.id,
    revisions: [original, changed],
  });

  const writer = Schema.decodeSync(CategoryTaxonomyRelease)({ ...prepared, write: changed.id });
  expect(compatibleCategoryReleases({ serving: currentCategoryRelease, candidate: writer })).toBe(
    false
  );
  expect(compatibleCategoryReleases({ serving: currentCategoryRelease, candidate: prepared })).toBe(
    true
  );
  expect(compatibleCategoryReleases({ serving: prepared, candidate: writer })).toBe(true);
  expect(
    interpretCategory({
      release: writer,
      reference: { revision: original.id, categoryId: categoryIds.mercado },
    })
  ).toEqual(Option.some({ id: categoryIds.mercado, label: "Mercado" }));
  expect(
    interpretCategory({
      release: writer,
      reference: { revision: changed.id, categoryId: categoryIds.mercado },
    })
  ).toEqual(Option.some({ id: categoryIds.mercado, label: "Alimentos" }));

  const reassigned = Schema.decodeSync(CategoryTaxonomyRelease)({
    write: original.id,
    revisions: [{ ...changed, id: original.id }],
  });

  expect(
    compatibleCategoryReleases({ serving: currentCategoryRelease, candidate: reassigned })
  ).toBe(false);
});

it("rejects an incomplete revision, duplicate identities or a catalog larger than the public operation can return", () => {
  const original = currentCategoryRelease.revisions[0];

  if (original === undefined) throw new Error("Missing initial taxonomy");
  expect(Schema.is(CategoryTaxonomyRelease)({ ...currentCategoryRelease, write: "co-9" })).toBe(
    false
  );
  expect(
    Schema.is(CategoryTaxonomyRelease)({
      write: "co-1",
      revisions: [
        {
          ...original,
          categories: original.categories.filter((item) => item.id !== categoryIds.otros),
        },
      ],
    })
  ).toBe(false);
  expect(
    Schema.is(CategoryTaxonomyRelease)({
      write: "co-1",
      revisions: [{ ...original, categories: [...original.categories, ...original.categories] }],
    })
  ).toBe(false);

  const extra = Array.from({ length: 100 }, (_, index) => ({
    id: "20000000-0000-4000-8000-" + String(index).padStart(12, "0"),
    label: "Prueba",
  }));

  expect(
    Schema.is(CategoryTaxonomyRelease)({
      write: "co-1",
      revisions: [{ ...original, categories: [...original.categories, ...extra] }],
    })
  ).toBe(false);
});
