// @effect-diagnostics nodeBuiltinImport:off - The fake HTTP server counts incoming byte chunks.
import * as NodeHttp from "node:http";

export const FIRST_PROMPT =
  "Inspect the sample checkout tests and explain which wait condition is wrong.";
export const NEXT_PROMPT = "Summarize the proposed fix for the checkout test in one sentence.";
export const ANSWER = "Wait for the hydrated rows.";

export const PROVIDERS = ["codex", "claude", "antigravity"] as const;
export type Provider = (typeof PROVIDERS)[number];

interface Sample {
  readonly bytes: number;
  readonly route: string;
  readonly model: string;
  readonly raw: string;
  readonly body: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

function array(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function jsonBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value));
}

export function measureTurn(
  samples: readonly Sample[],
  model: string,
  prompt: string,
  followUp: boolean,
) {
  const primary = samples.reduce<Sample | undefined>(
    (largest, sample) =>
      sample.route !== "/v1/messages/count_tokens" &&
      sample.model === model &&
      sample.raw.includes(prompt) &&
      sample.bytes >= (largest?.bytes ?? 0)
        ? sample
        : largest,
    undefined,
  );
  if (!primary) {
    throw new Error(
      `No ${model} request carried the current prompt. Models seen: ${samples.map(({ model }) => model).join(", ")}`,
    );
  }
  const { body } = primary;
  const input = array(body.input ?? body.messages ?? body.contents);
  const isInstruction = (item: unknown) => {
    const role = record(item)?.role;
    return role === "developer" || role === "system";
  };
  const isToolInventory = (item: unknown) => record(item)?.type === "additional_tools";
  const history = input.filter((item) => !isInstruction(item) && !isToolInventory(item));
  const historyJson = JSON.stringify(history);
  if (historyJson.split(prompt).length !== 2) {
    throw new Error(`The ${model} primary request must carry the prompt once in its input`);
  }
  if (followUp && (!historyJson.includes(FIRST_PROMPT) || !historyJson.includes(ANSWER))) {
    throw new Error(`The ${model} follow-up must carry the previous prompt and reply`);
  }
  const instructions = [
    body.instructions,
    body.system,
    body.systemInstruction,
    ...input.filter(isInstruction),
  ].filter((value) => value !== undefined);
  const tools = [
    ...array(body.tools),
    ...input.filter(isToolInventory).flatMap((item) => array(record(item)?.tools)),
  ];
  const auxiliary = samples.filter((sample) => sample !== primary);
  return {
    bytes: samples.reduce((sum, sample) => sum + sample.bytes, 0),
    calls: samples.length,
    primaryBytes: primary.bytes,
    inputBytes: jsonBytes(history),
    instructionBytes: jsonBytes(instructions),
    toolBytes: jsonBytes(tools),
    auxiliaryBytes: auxiliary.reduce((sum, sample) => sum + sample.bytes, 0),
    auxiliaryCalls: auxiliary.length,
    requests: samples.map(({ bytes, route, model }, index) => ({
      bytes,
      route,
      model,
      primary: samples[index] === primary,
    })),
  };
}

function sse(events: readonly object[]) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function codexResponse(index: number) {
  const item = {
    id: `msg_fixture_${index}`,
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: ANSWER, annotations: [] }],
  };
  const response = {
    id: `resp_fixture_${index}`,
    object: "response",
    status: "completed",
    output: [item],
    usage: { input_tokens: 200, output_tokens: 8, total_tokens: 208 },
  };
  return sse([
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  ]);
}

function claudeResponse(index: number, model: string) {
  return [
    {
      type: "message_start",
      message: {
        id: `msg_fixture_${index}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 200, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ANSWER } },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 8 },
    },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

function geminiResponse() {
  return {
    candidates: [
      { content: { role: "model", parts: [{ text: ANSWER }] }, finishReason: "STOP", index: 0 },
    ],
    usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 8, totalTokenCount: 208 },
  };
}

export async function startModelEndpoint(provider: Provider) {
  const requests: Sample[] = [];
  const unexpected = new Set<string>();
  const server = NodeHttp.createServer(async (request, response) => {
    const route = request.url?.split("?")[0] ?? "";
    const gemini = /^\/v1beta\/models\/([\w.-]+):(streamGenerateContent|generateContent)$/.exec(
      route,
    );
    const anthropic =
      provider === "claude" && ["/v1/messages", "/v1/messages/count_tokens"].includes(route);
    const known =
      provider === "codex"
        ? route === "/v1/responses"
        : anthropic || (provider === "antigravity" && gemini !== null);
    if (request.method !== "POST" || !known) {
      unexpected.add(`${request.method} ${route}`);
      response.writeHead(404).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 4 * 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = record(JSON.parse(raw));
      const model = gemini?.[1] ?? body?.model;
      if (body === undefined || typeof model !== "string") {
        response.writeHead(400).end();
        return;
      }
      requests.push({ bytes, route, model, raw, body });
      const json = route.endsWith("/count_tokens")
        ? { input_tokens: 200 }
        : gemini?.[2] === "generateContent"
          ? geminiResponse()
          : anthropic && body.stream !== true
            ? {
                id: `msg_fixture_${requests.length}`,
                type: "message",
                role: "assistant",
                model,
                content: [{ type: "text", text: ANSWER }],
                stop_reason: "end_turn",
                stop_sequence: null,
                usage: { input_tokens: 200, output_tokens: 8 },
              }
            : undefined;
      if (json !== undefined) {
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(json));
        return;
      }
      response
        .writeHead(200, { "Content-Type": "text/event-stream" })
        .end(
          provider === "codex"
            ? codexResponse(requests.length)
            : anthropic
              ? claudeResponse(requests.length, model)
              : sse([geminiResponse()]),
        );
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Missing model endpoint TCP address");
  return {
    port: address.port,
    requests,
    unexpected,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
