import { type JSX, useContext } from "react";
import { Option } from "effect";
import { CaptureEditorContext, type CaptureEditorProps } from "./capture-context";

export const CaptureEditor = (props: CaptureEditorProps): JSX.Element =>
  Option.match(useContext(CaptureEditorContext), {
    onNone: () => <p role="alert">No pudimos abrir el registro de transacciones.</p>,
    onSome: (Editor) => <Editor {...props} />,
  });
