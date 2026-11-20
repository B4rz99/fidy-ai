import { Agent, setGlobalDispatcher } from "undici";

setGlobalDispatcher(new Agent());
