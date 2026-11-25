import { failure } from "./drafts.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const LIST_PAGE_SIZE = 64;
const MAX_ACTIVE_CALLS = 64;
const MAX_ARGUMENT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 2 * 1024 * 1024;

export const plainObject = value => {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export function checkArguments(value) {
  if (!plainObject(value) || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_ARGUMENT_BYTES) {
    throw failure("INVALID_ARGUMENT", "OpenReel tool arguments must be a bounded JSON object.");
  }
}

const requestId = id => (typeof id === "string" && id.length > 0 && id.length <= 128) || Number.isSafeInteger(id);
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });

function toolFailure(error, signal) {
  const known = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code);
  const code = signal?.aborted || error?.name === "AbortError" ? "TOOL_ABORTED"
    : known ? error.code : "TOOL_FAILED";
  const message = code === "TOOL_ABORTED" ? "OpenReel tool call was cancelled."
    : known && typeof error?.message === "string" ? error.message.slice(0, 1000)
    : "OpenReel could not complete the tool call.";
  return { isError: true, structuredContent: { code, message }, content: [{ type: "text", text: message }] };
}

function toolSuccess(result) {
  const value = plainObject(result) ? result : { value: result ?? null };
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) {
    return { content: [{ type: "text", text: "The result is large. Read specific sections of the draft." }],
      structuredContent: { ...(Number.isSafeInteger(value.revision) ? { revision: value.revision } : {}),
        truncated: true } };
  }
  return { content: [{ type: "text", text }], structuredContent: value };
}

export function createMcpServer(tools, execute) {
  const active = new Map();
  let handshake = "fresh";

  return async function exchange(message, context) {
    if (!plainObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(null, -32600, "Invalid JSON-RPC request.");
    }
    const { id, method, params } = message;
    if (id === undefined) {
      if (method === "notifications/initialized" && handshake === "initializing") handshake = "ready";
      if (method === "notifications/cancelled" && requestId(params?.requestId)) {
        active.get(params.requestId)?.abort();
      }
      return null;
    }
    if (!requestId(id)) return rpcError(null, -32600, "Invalid JSON-RPC request ID.");
    if (method === "ping") return rpcResult(id, {});
    if (method === "initialize") {
      if (typeof params?.protocolVersion !== "string" || !plainObject(params.capabilities) ||
          !plainObject(params.clientInfo) || typeof params.clientInfo.name !== "string" ||
          typeof params.clientInfo.version !== "string") {
        return rpcError(id, -32602, "Invalid MCP initialization.");
      }
      if (handshake === "fresh") handshake = "initializing";
      return rpcResult(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} },
        serverInfo: { name: "openreel", version: "1.0.0" } });
    }
    if (handshake !== "ready") return rpcError(id, -32002, "Initialize the OpenReel MCP connection first.");

    if (method === "tools/list") {
      const catalog = tools();
      const cursor = params?.cursor;
      const offset = cursor === undefined ? 0 : typeof cursor === "string" && /^\d{1,4}$/.test(cursor) ? Number(cursor) : -1;
      if (offset < 0 || offset > catalog.length || offset % LIST_PAGE_SIZE !== 0) {
        return rpcError(id, -32602, "Invalid MCP tool cursor.");
      }
      const next = offset + LIST_PAGE_SIZE;
      return rpcResult(id, { tools: catalog.slice(offset, next), ...(next < catalog.length ? { nextCursor: String(next) } : {}) });
    }
    if (method !== "tools/call") return rpcError(id, -32601, "Unknown MCP method.");
    if (!plainObject(params) || typeof params.name !== "string" || params.name.length > 128 ||
        (params.arguments !== undefined && !plainObject(params.arguments))) {
      return rpcError(id, -32602, "Invalid MCP tool request.");
    }
    if (!context?.sessionId) return rpcError(id, -32001, "OpenReel requires a trusted session context.");
    if (active.has(id) || active.size >= MAX_ACTIVE_CALLS) {
      return rpcError(id, -32000, "Too many or duplicate active OpenReel calls.");
    }
    const controller = new AbortController();
    const signal = context.signal ? AbortSignal.any([context.signal, controller.signal]) : controller.signal;
    active.set(id, controller);
    try {
      signal.throwIfAborted();
      const args = params.arguments ?? {};
      checkArguments(args);
      const value = await execute(params.name, args, { ...context, signal });
      return rpcResult(id, toolSuccess(value));
    } catch (error) {
      return rpcResult(id, toolFailure(error, signal));
    } finally {
      active.delete(id);
    }
  };
}
