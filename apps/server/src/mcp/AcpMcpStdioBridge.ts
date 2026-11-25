// Relay JSON-RPC verbatim outside the opt-in Antigravity catalog.
// @effect-diagnostics globalJsonInEffect:off
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { discardResponseBody, responsePayloads } from "@t3tools/shared/mcpResponsePayloads";
import {
  MCP_TOOL_EXPOSURE_BRIDGE_ENV,
  MCP_TOOL_EXPOSURE_COMPACT,
  MCP_TOOL_EXPOSURE_HEADER,
  MCP_TOOL_EXPOSURE_THEME_BROKER,
} from "@t3tools/provider-core/server/mcpSession";
import { isDirectTool, TOOL_SEARCH } from "./McpToolExposure.ts";

/** ACP mandates stdio MCP support; HTTP/SSE support varies. */

const JsonRpcError = Schema.Struct({ code: Schema.Number, message: Schema.String });

export class AcpMcpBridgeError extends Schema.TaggedError<AcpMcpBridgeError>()(
  "AcpMcpBridgeError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    /** The JSON-RPC error the server answered with, when it answered. */
    rpcError: Schema.optional(JsonRpcError),
  },
) {}

const decodeRpcError = Schema.decodeUnknownOption(JsonRpcError);

const isAcpMcpBridgeError = Schema.is(AcpMcpBridgeError);

const bridgeError = (cause: unknown): AcpMcpBridgeError =>
  isAcpMcpBridgeError(cause)
    ? cause
    : new AcpMcpBridgeError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const decodeJsonLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const ExtraFields = Schema.Record(Schema.String, Schema.Unknown);
const decodeToolsList = Schema.decodeUnknownOption(
  Schema.StructWithRest(
    Schema.Struct({
      tools: Schema.Array(
        Schema.StructWithRest(
          Schema.Struct({ name: Schema.String, description: Schema.optionalKey(Schema.String) }),
          [ExtraFields],
        ),
      ),
    }),
    [ExtraFields],
  ),
);

interface JsonRpcEnvelope {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface AcpMcpStdioBridgeOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly compactTools?: boolean;
  readonly brokerThemeRead?: boolean;
  readonly input: NodeJS.ReadableStream;
  readonly output: { write(chunk: string): unknown };
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

function asEnvelope(value: unknown): JsonRpcEnvelope | null {
  return typeof value === "object" && value !== null ? (value as JsonRpcEnvelope) : null;
}

const THEME_READ = "t3_theme_read";
const CALL_T3_TOOL = "call_t3_tool";
const decodeToolCall = Schema.decodeUnknownOption(
  Schema.Struct({
    name: Schema.String,
    arguments: Schema.optionalKey(Schema.Unknown),
    _meta: Schema.optionalKey(ExtraFields),
  }),
);
const decodeThemeCall = Schema.decodeUnknownOption(
  Schema.Struct({
    toolName: Schema.Literal(THEME_READ),
    arguments: ExtraFields,
  }),
  { onExcessProperty: "error" },
);
const decodeSearch = Schema.decodeUnknownOption(
  Schema.Struct({ query: Schema.String.check(Schema.isMaxLength(500)) }),
  { onExcessProperty: "error" },
);
const callThemeTool = {
  name: CALL_T3_TOOL,
  description:
    "Call the read-only T3 Code tool t3_theme_read. Use tool_search to get its full argument schema.",
  inputSchema: {
    type: "object",
    properties: {
      toolName: { type: "string", enum: [THEME_READ] },
      arguments: { type: "object", additionalProperties: true },
    },
    required: ["toolName", "arguments"],
    additionalProperties: false,
  },
};

function compactListedTools(value: unknown) {
  const envelope = asEnvelope(value);
  const listed = Option.getOrUndefined(decodeToolsList(envelope?.result));
  if (envelope === null || listed === undefined) return value;
  return {
    ...envelope,
    result: {
      ...listed,
      tools: listed.tools.map((tool) => {
        if (tool.name === TOOL_SEARCH) {
          return {
            ...tool,
            description:
              `${tool.description ?? ""} Search an exact tool name to get its full argument schema.`.trim(),
          };
        }
        // agy snapshots names for the active turn. Keep each name callable and let T3 validate the arguments.
        return isDirectTool(tool.name)
          ? tool
          : { ...tool, inputSchema: { type: "object", additionalProperties: true } };
      }),
    },
  };
}

function protocolVersionOf(entry: unknown): string | null {
  const result = asEnvelope(entry)?.result;
  const version =
    typeof result === "object" && result !== null
      ? (result as { readonly protocolVersion?: unknown }).protocolVersion
      : undefined;
  return typeof version === "string" && version.length > 0 ? version : null;
}

function replyToServerRequest(envelope: JsonRpcEnvelope): unknown {
  return envelope.method === "ping"
    ? { jsonrpc: "2.0", id: envelope.id, result: {} }
    : { jsonrpc: "2.0", id: envelope.id, error: { code: -32601, message: "Method not found" } };
}

export interface McpToolSessionOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly clientName: string;
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface McpToolSession {
  /** Resolves to the JSON-RPC `result` of `tools/call`, a `CallToolResult`. */
  readonly call: (
    tool: string,
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, AcpMcpBridgeError>;
}

/**
 * One initialized MCP session over T3 Code's HTTP endpoint, terminated when
 * the scope closes. Used by the ACP terminal fallback and `t3 thread`.
 */
export const mcpToolSession = (
  options: McpToolSessionOptions,
): Effect.Effect<McpToolSession, AcpMcpBridgeError, Scope.Scope> => {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let nextId = 0;

  const headers = () => ({
    accept: "application/json, text/event-stream",
    authorization: options.authorization,
    ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
    ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
  });

  const send = Effect.fn("AcpMcpStdioBridge.send")(function* (
    message: unknown,
  ): Effect.fn.Return<ReadonlyArray<unknown>, AcpMcpBridgeError> {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetchImplementation(options.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers() },
          body: JSON.stringify(message),
          signal,
        }),
      catch: bridgeError,
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (!response.ok) {
      yield* discardResponseBody(response);
      return yield* new AcpMcpBridgeError({
        message: `T3 Code MCP endpoint responded with HTTP ${response.status}.`,
      });
    }
    const payloads: Array<unknown> = [];
    yield* Stream.runForEach(responsePayloads(response, bridgeError), (payload) => {
      protocolVersion = protocolVersionOf(payload) ?? protocolVersion;
      const envelope = asEnvelope(payload);
      if (envelope?.id !== undefined && typeof envelope.method === "string") {
        return send(replyToServerRequest(envelope)).pipe(Effect.asVoid);
      }
      payloads.push(payload);
      return Effect.void;
    });
    return payloads;
  });

  const request = Effect.fn("AcpMcpStdioBridge.request")(function* (
    method: string,
    params: unknown,
  ): Effect.fn.Return<JsonRpcEnvelope, AcpMcpBridgeError> {
    const id = `t3-cli-${nextId++}`;
    const responses = yield* send({ jsonrpc: "2.0", id, method, params });
    const envelope = asEnvelope(responses.find((entry) => asEnvelope(entry)?.id === id));
    if (envelope === null || envelope.error !== undefined) {
      const rpcError = Option.getOrUndefined(decodeRpcError(envelope?.error));
      return yield* new AcpMcpBridgeError({
        message: `T3 Code MCP ${method} failed${envelope?.error === undefined ? "." : `: ${JSON.stringify(envelope.error)}`}`,
        ...(rpcError === undefined ? {} : { rpcError }),
      });
    }
    return envelope;
  });

  const terminate = Effect.suspend(() =>
    sessionId === null
      ? Effect.void
      : Effect.tryPromise({
          try: () =>
            fetchImplementation(options.endpoint, { method: "DELETE", headers: headers() }),
          catch: bridgeError,
        }).pipe(Effect.flatMap(discardResponseBody), Effect.ignore),
  );

  // Registered before the handshake so a session the server opened is ended
  // even when the handshake fails, and the handshake stays interruptible.
  return Effect.gen(function* () {
    yield* Effect.addFinalizer(() => terminate);
    yield* request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: options.clientName, version: "0.0.0" },
    });
    yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return {
      call: (tool, args) =>
        request("tools/call", { name: tool, arguments: args }).pipe(
          Effect.map((envelope) => envelope.result),
        ),
    } satisfies McpToolSession;
  });
};

/**
 * This is the terminal fallback for ACP agents that accept `mcpServers` in
 * `session/new` but fail to expose those tools to their model. Compliant ACP
 * agents continue to use the stdio bridge above.
 */
function callAcpMcpTool(options: {
  readonly endpoint: string;
  readonly authorization: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}): Effect.Effect<unknown, AcpMcpBridgeError> {
  return mcpToolSession({ ...options, clientName: "t3-code-acp-cli" }).pipe(
    Effect.flatMap((session) => session.call(options.tool, options.arguments)),
    Effect.scoped,
  );
}

export function runAcpMcpStdioBridge(options: AcpMcpStdioBridgeOptions): Effect.Effect<void> {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  return Effect.gen(function* () {
    let sessionId: string | null = null;
    let protocolVersion: string | null = null;
    let canBrokerTheme = false;
    const running = new Set<Fiber.Fiber<void>>();

    const writeMessage = (message: unknown): Effect.Effect<void> =>
      Effect.sync(() => {
        options.output.write(`${JSON.stringify(message)}\n`);
      });

    const handleServerPayload = Effect.fn("AcpMcpStdioBridge.handleServerPayload")(function* (
      payload: unknown,
      listing: boolean,
    ): Effect.fn.Return<void> {
      for (const entry of Array.isArray(payload) ? payload : [payload]) {
        protocolVersion = protocolVersionOf(entry) ?? protocolVersion;
        if (listing && options.brokerThemeRead) {
          const envelope = asEnvelope(entry);
          const listed = Option.getOrUndefined(decodeToolsList(envelope?.result));
          if (envelope !== null && listed !== undefined) {
            canBrokerTheme = listed.tools.some(({ name }) => name === THEME_READ);
            const direct = listed.tools.flatMap((tool) => {
              if (tool.name === TOOL_SEARCH) {
                return canBrokerTheme
                  ? [
                      {
                        ...tool,
                        description:
                          "Discover the read-only T3 Code tool t3_theme_read and its argument schema. Call it with call_t3_tool.",
                      },
                    ]
                  : [];
              }
              return isDirectTool(tool.name) ? [tool] : [];
            });
            yield* writeMessage({
              ...envelope,
              result: { ...listed, tools: canBrokerTheme ? [...direct, callThemeTool] : direct },
            });
            continue;
          }
        }
        yield* writeMessage(listing && options.compactTools ? compactListedTools(entry) : entry);
      }
    });

    const respondWithError = (
      requestId: unknown,
      message: string,
      code = -32603,
    ): Effect.Effect<void> =>
      writeMessage({
        jsonrpc: "2.0",
        id: requestId ?? null,
        error: { code, message },
      });

    const forward: (line: string, envelope: JsonRpcEnvelope) => Effect.Effect<void> = Effect.fn(
      "AcpMcpStdioBridge.forward",
    )(
      function* (line: string, envelope: JsonRpcEnvelope) {
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetchImplementation(options.endpoint, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: options.authorization,
                ...(options.compactTools || options.brokerThemeRead
                  ? { [MCP_TOOL_EXPOSURE_HEADER]: MCP_TOOL_EXPOSURE_COMPACT }
                  : {}),
                ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
                ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
              },
              body: line,
              signal,
            }),
          catch: bridgeError,
        });
        sessionId = response.headers.get("mcp-session-id") ?? sessionId;
        if (!response.ok) {
          if (envelope.id !== undefined) {
            yield* respondWithError(
              envelope.id,
              `T3 Code MCP endpoint responded with HTTP ${response.status}.`,
            );
          }
          return yield* discardResponseBody(response);
        }
        yield* Stream.runForEach(responsePayloads(response, bridgeError), (payload) =>
          handleServerPayload(payload, envelope.method === "tools/list"),
        );
      },
      (effect, _line, envelope) =>
        effect.pipe(
          Effect.catchCause((cause) => {
            if (envelope.id === undefined) return Effect.void;
            const error = Cause.squash(cause);
            return respondWithError(
              envelope.id,
              `T3 Code MCP bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }),
        ),
    );

    const forwardBrokerCall = Effect.fn("AcpMcpStdioBridge.forwardBrokerCall")(function* (
      line: string,
      envelope: JsonRpcEnvelope,
    ): Effect.fn.Return<void> {
      const call = Option.getOrUndefined(decodeToolCall(envelope.params));
      if (call === undefined)
        return yield* respondWithError(envelope.id, "Invalid tool call.", -32602);
      const send = (name: string, args: unknown) =>
        forward(
          JSON.stringify({ ...envelope, params: { ...call, name, arguments: args } }),
          envelope,
        );
      if (call.name === TOOL_SEARCH && canBrokerTheme) {
        const search = Option.getOrUndefined(decodeSearch(call.arguments));
        if (search === undefined)
          return yield* respondWithError(envelope.id, "Invalid tool search.", -32602);
        if (/theme/i.test(search.query)) return yield* send(TOOL_SEARCH, { query: THEME_READ });
        return yield* writeMessage({
          jsonrpc: "2.0",
          id: envelope.id,
          result: {
            content: [{ type: "text", text: '{"tools":[]}' }],
            structuredContent: { tools: [] },
          },
        });
      }
      if (call.name === CALL_T3_TOOL && canBrokerTheme) {
        const target = Option.getOrUndefined(decodeThemeCall(call.arguments));
        if (target !== undefined) return yield* send(THEME_READ, target.arguments);
      } else if (call.name !== TOOL_SEARCH && isDirectTool(call.name)) {
        return yield* forward(line, envelope);
      }
      return yield* respondWithError(
        envelope.id,
        "This tool is unavailable through the Antigravity broker.",
        -32602,
      );
    });

    // Order only session establishment; SSE responses must bypass it to avoid deadlock. Calls remain concurrent after initialization.
    let sessionBarrier: Effect.Effect<void> = Effect.void;
    let sessionBarrierPending = false;

    const launch = Effect.fn("AcpMcpStdioBridge.launch")(function* (
      task: Effect.Effect<void>,
    ): Effect.fn.Return<void> {
      const fiber = yield* Effect.forkChild(task);
      running.add(fiber);
      yield* Effect.forkChild(
        Fiber.await(fiber).pipe(
          Effect.andThen(
            Effect.sync(() => {
              running.delete(fiber);
            }),
          ),
        ),
      );
    });

    const dispatch = Effect.fn("AcpMcpStdioBridge.dispatch")(function* (
      line: string,
    ): Effect.fn.Return<void> {
      if (line.trim().length === 0) return;
      const parsed = decodeJsonLine(line);
      if (Option.isNone(parsed)) {
        return yield* respondWithError(null, "Parse error", -32700);
      }
      const envelope = asEnvelope(parsed.value);
      if (envelope === null) return;
      const isResponse = envelope.id !== undefined && ("result" in envelope || "error" in envelope);
      const isSessionHandshake =
        envelope.method === "initialize" || envelope.method === "notifications/initialized";
      if (isResponse) {
        return yield* launch(forward(line, envelope));
      }
      if (isSessionHandshake) {
        const prior = sessionBarrier;
        const fiber = yield* Effect.forkChild(prior.pipe(Effect.andThen(forward(line, envelope))));
        running.add(fiber);
        const barrier = Fiber.await(fiber).pipe(Effect.asVoid);
        sessionBarrier = barrier;
        sessionBarrierPending = true;
        yield* Effect.forkChild(
          Fiber.await(fiber).pipe(
            Effect.andThen(
              Effect.sync(() => {
                running.delete(fiber);
                if (sessionBarrier === barrier) sessionBarrierPending = false;
              }),
            ),
          ),
        );
        return;
      }
      const request =
        options.brokerThemeRead && envelope.method === "tools/call"
          ? forwardBrokerCall(line, envelope)
          : forward(line, envelope);
      const task = sessionBarrierPending ? sessionBarrier.pipe(Effect.andThen(request)) : request;
      return yield* launch(task);
    });

    // node:readline also splits on U+2028/U+2029, which JSON.stringify leaves raw inside strings.
    yield* Stream.fromAsyncIterable(options.input, bridgeError).pipe(
      Stream.map((chunk) => (typeof chunk === "string" ? Buffer.from(chunk) : chunk)),
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach(dispatch),
      Effect.ignoreCause,
    );
    yield* Fiber.awaitAll(running);
  });
}

async function readStdin(): Promise<string> {
  const chunks: Array<Buffer> = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Avoid heavy imports on the ACP first-message path. */
export async function runAcpMcpCliFastPath(
  command: "acp-mcp-bridge" | "acp-mcp-call",
  args: ReadonlyArray<string>,
): Promise<void> {
  const endpoint = process.env.T3_ACP_MCP_ENDPOINT;
  const authorization = process.env.T3_ACP_MCP_AUTHORIZATION;
  if (endpoint === undefined || authorization === undefined) {
    process.stderr.write(`${command} requires T3_ACP_MCP_ENDPOINT and T3_ACP_MCP_AUTHORIZATION.\n`);
    process.exitCode = 2;
    return;
  }
  if (command === "acp-mcp-bridge") {
    await Effect.runPromise(
      runAcpMcpStdioBridge({
        endpoint,
        authorization,
        compactTools: process.env[MCP_TOOL_EXPOSURE_BRIDGE_ENV] === MCP_TOOL_EXPOSURE_COMPACT,
        brokerThemeRead:
          process.env[MCP_TOOL_EXPOSURE_BRIDGE_ENV] === MCP_TOOL_EXPOSURE_THEME_BROKER,
        input: process.stdin,
        output: process.stdout,
      }),
    );
    return;
  }
  const [tool, argumentsArg] = args;
  if (tool === undefined || argumentsArg === undefined) {
    process.stderr.write(
      "acp-mcp-call requires <tool> and <arguments-json>, or - to read it from stdin.\n",
    );
    process.exitCode = 2;
    return;
  }
  // Windows PowerShell 5.1 strips the quotes from JSON passed as an argument; stdin keeps them.
  const argumentsJson = argumentsArg === "-" ? await readStdin() : argumentsArg;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    process.stderr.write("acp-mcp-call arguments must be valid JSON.\n");
    process.exitCode = 2;
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write("acp-mcp-call arguments must be a JSON object.\n");
    process.exitCode = 2;
    return;
  }
  let result = await Effect.runPromise(
    callAcpMcpTool({
      endpoint,
      authorization,
      tool,
      arguments: parsed as Record<string, unknown>,
    }),
  );
  // Terminal callers see both fields, unlike native MCP clients that choose one.
  if (
    typeof result === "object" &&
    result !== null &&
    "structuredContent" in result &&
    result.structuredContent !== undefined &&
    "content" in result &&
    Array.isArray(result.content)
  ) {
    const encoded = JSON.stringify(result.structuredContent);
    result = {
      ...result,
      content: result.content.filter(
        (part: unknown) =>
          !(
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            part.type === "text" &&
            "text" in part &&
            part.text === encoded
          ),
      ),
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
