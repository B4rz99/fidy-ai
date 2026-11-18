import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { nativeApplication, nativeState } from "./native-application";
import { nativeStack } from "./storage-installation";

export default Alchemy.Stack(
  nativeStack,
  { providers: Cloudflare.providers(), state: nativeState },
  nativeApplication
);
