import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { expect, it } from "vite-plus/test";
import {
  ANSWER,
  FIRST_PROMPT,
  NEXT_PROMPT,
  measureTurn,
  startModelEndpoint,
} from "./model-request-endpoint.ts";

function sample(model: string, body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  return { model, route: "/v1/responses", body, raw, bytes: Buffer.byteLength(raw) };
}

it("counts UTF-8 bodies and inventories even when an auxiliary request is larger", () => {
  const input = [{ role: "user", content: FIRST_PROMPT }];
  const developer = { role: "developer", content: "Use the café fixture" };
  const tool = { name: "report", parameters: { type: "object" } };
  const primary = sample("primary", {
    input: [...input, developer, { type: "additional_tools", tools: [tool] }],
  });
  const auxiliary = {
    ...sample("primary", { input: FIRST_PROMPT + "x".repeat(512) }),
    route: "/v1/messages/count_tokens",
  };
  const result = measureTurn([auxiliary, primary], "primary", FIRST_PROMPT, false);

  expect(result).toMatchObject({
    bytes: primary.bytes + auxiliary.bytes,
    calls: 2,
    primaryBytes: primary.bytes,
    inputBytes: Buffer.byteLength(JSON.stringify(input)),
    instructionBytes: Buffer.byteLength(JSON.stringify([developer])),
    toolBytes: Buffer.byteLength(JSON.stringify([tool])),
    auxiliaryBytes: auxiliary.bytes,
    auxiliaryCalls: 1,
    requests: [{ primary: false }, { primary: true }],
  });
});

it("requires a follow-up body to contain the previous user prompt and answer", () => {
  const next = { role: "user", content: NEXT_PROMPT };
  const first = { role: "user", content: FIRST_PROMPT };
  const reply = { role: "assistant", content: ANSWER };
  expect(() =>
    measureTurn([sample("model", { messages: [first, next] })], "model", NEXT_PROMPT, true),
  ).toThrow("previous prompt and reply");
  expect(
    measureTurn([sample("model", { messages: [first, reply, next] })], "model", NEXT_PROMPT, true)
      .calls,
  ).toBe(1);
});

effectIt.live(
  "fails measurement after a rejected auxiliary request even if the agent request succeeds",
  () =>
    Effect.gen(function* () {
      const endpoint = yield* Effect.acquireRelease(
        Effect.promise(() => startModelEndpoint("claude")),
        (endpoint) => Effect.promise(() => endpoint.close()),
      );
      const messages = [{ role: "user", content: FIRST_PROMPT }];
      const send = (route: string, body: string) =>
        HttpClient.execute(
          HttpClientRequest.post(`http://127.0.0.1:${endpoint.port}${route}`).pipe(
            HttpClientRequest.bodyText(body),
          ),
        );
      const oversized = yield* send("/v1/messages/count_tokens", "x".repeat(4 * 1024 * 1024 + 1));
      expect(oversized.status).toBe(413);
      const malformed = yield* send("/v1/messages/count_tokens", "{");
      expect(malformed.status).toBe(400);
      const reply = yield* send("/v1/messages", JSON.stringify({ model: "fixture", messages }));
      expect(reply.status).toBe(200);
      expect(yield* reply.text).toContain(ANSWER);
      expect(() => endpoint.readRequests()).toThrow("/v1/messages/count_tokens (413)");
      expect(() => endpoint.readRequests()).toThrow("/v1/messages/count_tokens (400)");
    }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
);
