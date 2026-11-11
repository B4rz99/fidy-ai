import { Data, DateTime, Option } from "effect";
import { Atom, type AtomRegistry } from "effect/reactivity";
import type { Item } from "./model";

type OriginalReference = Pick<Item, "id" | "expiresAt">;
const retainedDeadline = Atom.family((_id: Item["id"]) =>
  Atom.make(Option.none<Item["expiresAt"]>()).pipe(Atom.keepAlive)
);
export const earlierOriginalDeadline = ({
  first,
  second,
}: Readonly<{
  first: Item["expiresAt"];
  second: Item["expiresAt"];
}>): Item["expiresAt"] =>
  DateTime.toEpochMillis(first) <= DateTime.toEpochMillis(second) ? first : second;

/** Retain only the earliest observed timestamp until this authentication registry is disposed. */
export const observeOriginalDeadline = ({
  registry,
  item,
}: Readonly<{
  registry: AtomRegistry.AtomRegistry;
  item: OriginalReference;
}>): Item["expiresAt"] => {
  const bound = retainedDeadline(item.id);
  const previous = registry.get(bound);
  const deadline = Option.match(previous, {
    onNone: () => item.expiresAt,
    onSome: (time) => earlierOriginalDeadline({ first: time, second: item.expiresAt }),
  });
  if (Option.isNone(previous) || deadline !== previous.value) {
    registry.set(bound, Option.some(deadline));
  }
  return deadline;
};
class OriginalDeadlineKey extends Data.Class<Readonly<{ id: Item["id"]; deadline: number }>> {}
const deadlineQuery = Atom.family(({ id, deadline }: OriginalDeadlineKey) =>
  Atom.make((get): Item["expiresAt"] => {
    const observed = observeOriginalDeadline({
      registry: get.registry,
      item: {
        id,
        expiresAt: DateTime.makeUnsafe(deadline),
      },
    });
    return Option.getOrElse(get(retainedDeadline(id)), () => observed);
  })
);
export const originalDeadlineQuery = (item: OriginalReference): Atom.Atom<Item["expiresAt"]> =>
  deadlineQuery(
    new OriginalDeadlineKey({ id: item.id, deadline: DateTime.toEpochMillis(item.expiresAt) })
  );
