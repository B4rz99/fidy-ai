import { Agent, setGlobalDispatcher } from "undici";

// Node 26.5.0's bundled HTTP/2 dispatcher queues streaming POST bodies behind the
// open MCP review stream. Use the isolated tool's pinned dispatcher, whose HTTP/2
// streams can run concurrently. TLS verification and OAuth policy remain enabled.
setGlobalDispatcher(new Agent());
