import { type Duration, Effect, Exit, Option, Scope } from "effect";
import { type ReactNode, type RefCallback, useState } from "react";
import { type SensitiveClipboard, makeSensitiveClipboard } from "./sensitive-clipboard";

type ClipboardOwner = Readonly<{
  scope: Scope.Closeable;
  command: SensitiveClipboard;
}>;

type MountedSensitiveClipboard = Readonly<{
  lifecycleRef: RefCallback<HTMLDivElement>;
  command: SensitiveClipboard;
}>;

const makeMountedClipboard = (lifetime: Duration.Input): MountedSensitiveClipboard => {
  let owner = Option.none<ClipboardOwner>();
  const command: SensitiveClipboard = {
    reveal: (onExpired): void => {
      if (Option.isSome(owner)) owner.value.command.reveal(onExpired);
    },
    copy: (value, onCopied): void => {
      if (Option.isSome(owner)) owner.value.command.copy(value, onCopied);
    },
    clear: (value): void => {
      if (Option.isSome(owner)) owner.value.command.clear(value);
    },
  };
  const lifecycleRef: RefCallback<HTMLDivElement> = (node) => {
    if (node === null) return;
    const scope = Scope.makeUnsafe();
    const mountedCommand = Effect.runSync(
      makeSensitiveClipboard(Option.fromUndefinedOr(globalThis.navigator.clipboard), lifetime).pipe(
        Scope.provide(scope)
      )
    );
    owner = Option.some({ scope, command: mountedCommand });
    return (): void => {
      owner = Option.none();
      Effect.runCallback(Scope.close(scope, Exit.void), { onExit: () => undefined });
    };
  };
  return { lifecycleRef, command };
};

/**
 * Configures one mounted command owner. `lifetime` is fixed at mount; replace the boundary to use a
 * different value. Children receive commands that become inert after unmount, and `className`
 * styles the rendered boundary element.
 */
export type SensitiveClipboardBoundaryProps = Readonly<{
  children: (clipboard: SensitiveClipboard) => ReactNode;
  className: Option.Option<string>;
  lifetime: Duration.Input;
}>;

/**
 * Provides sensitive clipboard commands whose timers and callbacks are owned by this mounted
 * boundary. Replacing or unmounting it immediately disables the commands and starts secret cleanup.
 */
export const SensitiveClipboardBoundary = ({
  children,
  className,
  lifetime,
}: SensitiveClipboardBoundaryProps): React.JSX.Element => {
  const [{ lifecycleRef, command }] = useState(() => makeMountedClipboard(lifetime));
  return (
    <div className={Option.getOrUndefined(className)} ref={lifecycleRef}>
      {children(command)}
    </div>
  );
};
