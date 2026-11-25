import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerRequest } from "effect/http";
import {
  MCP_TOOL_EXPOSURE_COMPACT,
  MCP_TOOL_EXPOSURE_HEADER,
} from "@t3tools/provider-core/server/mcpSession";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolExposure from "../../McpToolExposure.ts";
import { ToolSearchToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ToolSearchToolkit, {
  tool_search: McpToolAccess.readsAsCaller(({ query }) =>
    Effect.gen(function* () {
      const { thread } = yield* McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "tool_search")),
      );
      const exposure = yield* McpToolExposure.McpToolExposure;
      const request = Option.getOrUndefined(
        yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest),
      );
      const compact = request?.headers[MCP_TOOL_EXPOSURE_HEADER] === MCP_TOOL_EXPOSURE_COMPACT;
      return { tools: yield* exposure.search(thread.providerSessionId, query, compact) };
    }),
  ),
});
