import { Option } from "effect";
import {
  type Category,
  type CategoryReference,
  type CategoryTaxonomyRelease,
  type CategoryTaxonomyRevision,
} from "~/core/categories/contract";

export const writingTaxonomy = (release: CategoryTaxonomyRelease): CategoryTaxonomyRevision =>
  release.revisions.reduce((writing, revision) =>
    revision.id === release.write ? revision : writing
  );

export const interpretReference = ({
  release,
  reference,
}: Readonly<{
  release: CategoryTaxonomyRelease;
  reference: CategoryReference;
}>): Option.Option<Category> =>
  Option.fromUndefinedOr(
    release.revisions
      .find((item) => item.id === reference.revision)
      ?.categories.find((item) => item.id === reference.categoryId)
  );

const understands = (
  reader: CategoryTaxonomyRelease,
  revision: CategoryTaxonomyRevision
): boolean => {
  const definition = reader.revisions.find((item) => item.id === revision.id);

  return (
    definition !== undefined &&
    definition.categories.length === revision.categories.length &&
    definition.categories.every(
      (category, index) =>
        category.id === revision.categories[index]?.id &&
        category.label === revision.categories[index].label
    )
  );
};

export const canOverlap = ({
  serving,
  candidate,
}: Readonly<{ serving: CategoryTaxonomyRelease; candidate: CategoryTaxonomyRelease }>): boolean =>
  serving.revisions.every((revision) => understands(candidate, revision)) &&
  understands(serving, writingTaxonomy(candidate));
