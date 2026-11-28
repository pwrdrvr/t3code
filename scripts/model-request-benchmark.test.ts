import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { decodeBudgetCeilings } from "./model-request-benchmark.ts";
import ceilings from "./model-request-ceilings.json" with { type: "json" };

it.effect("requires a ceiling for every provider, turn, and metric", () =>
  Effect.gen(function* () {
    expect(yield* decodeBudgetCeilings(ceilings)).toEqual(ceilings);
    const missingProvider = structuredClone(ceilings);
    Reflect.deleteProperty(missingProvider, "codex");
    const missingTurn = structuredClone(ceilings);
    Reflect.deleteProperty(missingTurn.codex, "first");
    const missingMetric = structuredClone(ceilings);
    Reflect.deleteProperty(missingMetric.codex.first, "calls");
    for (const invalid of [
      missingProvider,
      missingTurn,
      missingMetric,
      { ...ceilings, codex: { ...ceilings.codex, next: { ...ceilings.codex.next, CallCount: 1 } } },
      { ...ceilings, codex: { ...ceilings.codex, next: { ...ceilings.codex.next, calls: "1" } } },
    ]) {
      expect(yield* Effect.result(decodeBudgetCeilings(invalid))).toMatchObject({
        _tag: "Failure",
      });
    }
  }),
);
