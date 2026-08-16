/** Recursively marks a value and all of its nested properties as readonly. */
export type Immutable<Value> = Value extends CallableFunction
  ? Value
  : Value extends string | number | boolean | bigint | symbol
    ? Value
    : Value extends ReadonlyArray<infer Element>
      ? ReadonlyArray<Immutable<Element>>
      : Value extends object
        ? { readonly [Key in keyof Value]: Immutable<Value[Key]> }
        : Value;
