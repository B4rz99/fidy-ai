// Seeding, fixture inspection and alternate-runtimes blocks must preserve their declared order.
/**
 * *
 * @template T
 * @param {readonly T[]} items Ordered inputs.
 * @param {(item:T)=>Promise<unknown>} visit Operation for one input.
 * @returns {Promise<void>}
 */
export const inOrder = (items, visit) =>
  items.reduce(
    (previous, item) =>
      previous.then(async () => {
        await visit(item);
      }),
    Promise.resolve()
  );
/**
 * @param {number} length Number of ordinals.
 */
export const indices = (length) => Array.from({ length }, (_, index) => index);
