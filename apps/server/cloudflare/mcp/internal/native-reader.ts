import { Option } from "effect";

/** SDK disposal joins native cancellation before releasing its resident lease and reader. */
export const leaseNativeReader = ({
  reader,
  releaseLease,
}: Readonly<{
  reader: Pick<ReadableStreamDefaultReader<unknown>, "cancel" | "releaseLock">;
  releaseLease: () => void;
}>): Readonly<{ finish: () => void; cancel: () => Promise<void> }> => {
  let released = false;
  let cancelling = false;
  let cancellation: Option.Option<Promise<void>> = Option.none();
  const finish = (): void => {
    if (released || cancelling) return;
    released = true;
    reader.releaseLock();
    releaseLease();
  };
  const cancel = (): Promise<void> => {
    if (Option.isSome(cancellation)) return cancellation.value;
    if (released) return Promise.resolve();
    cancelling = true;
    const pending = Promise.resolve()
      .then(() => reader.cancel())
      .finally(() => {
        cancelling = false;
        finish();
      });
    cancellation = Option.some(pending);
    return pending;
  };
  return { finish, cancel };
};
