import { Option } from "effect";
import type { Item } from "./model";

/** Event-owned draft queues remain reachable while an inbox decision waits for their saves. */
export type DraftBarrier = Map<Item["id"], () => Promise<Option.Option<number>>>;
export const flushReviewSelection = ({
  barrier,
  items,
}: Readonly<{ barrier: DraftBarrier; items: ReadonlyArray<Item> }>): Promise<
  Option.Option<ReadonlyArray<Item>>
> => Promise.all(items.map((item) => flushItem(barrier, item))).then(Option.all);
const flushItem = (barrier: DraftBarrier, item: Item): Promise<Option.Option<Item>> => {
  const flush = barrier.get(item.id);
  if (flush === undefined) return Promise.resolve(Option.some(item));
  return flush().then(Option.map((revision) => ({ ...item, revision })));
};
