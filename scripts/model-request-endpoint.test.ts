import { expect, it } from "vite-plus/test";
import { ANSWER, FIRST_PROMPT, NEXT_PROMPT, measureTurn } from "./model-request-endpoint.ts";

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
