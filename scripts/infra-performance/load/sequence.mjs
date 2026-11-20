// Seeding, fixture inspection and alternate-runtimes blocks must preserve their declared order.
export const inOrder = (items, visit) =>
  items.reduce((previous, item) => previous.then(() => visit(item)), Promise.resolve());
export const indices = (length) => Array.from({ length }, (_, index) => index);
