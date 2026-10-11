import { Option } from "effect";

type Input = HTMLInputElement | HTMLTextAreaElement;
export type PrivateInputs<Name extends string> = Readonly<{
  read: (name: Name) => string;
  bind: (name: Name, input: Input) => () => void;
  clear: (name: Name) => void;
  dispose: () => void;
}>;
/** Holds credential drafts only in a mounted capability and synchronously erases its DOM values. */
export const makePrivateInputs = <Name extends string>(): PrivateInputs<Name> => {
  const values = new Map<Name, string>();
  const elements = new Map<Name, Set<Input>>();
  let active = true;
  const read = (name: Name): string =>
    Option.getOrElse(Option.fromUndefinedOr(values.get(name)), () => "");
  return {
    read,
    bind: (name, input) => {
      const inputs = Option.getOrElse(
        Option.fromUndefinedOr(elements.get(name)),
        () => new Set<Input>()
      );
      elements.set(name, inputs);
      inputs.add(input);
      input.value = read(name);
      const edit = (): void => {
        if (active) values.set(name, input.value);
      };
      input.addEventListener("input", edit);
      return () => {
        input.removeEventListener("input", edit);
        input.value = "";
        inputs.delete(input);
      };
    },
    clear: (name) => {
      values.delete(name);
      for (const input of Option.getOrElse(
        Option.fromUndefinedOr(elements.get(name)),
        () => new Set<Input>()
      )) {
        input.value = "";
      }
    },
    dispose: () => {
      active = false;
      values.clear();
      for (const inputs of elements.values()) for (const input of inputs) input.value = "";
      elements.clear();
    },
  };
};
