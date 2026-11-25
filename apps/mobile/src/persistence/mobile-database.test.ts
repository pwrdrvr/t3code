import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const openDatabaseAsync = vi.hoisted(() => vi.fn());

vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));

import * as MobileDatabase from "./mobile-database";

describe("offline cache", () => {
  const environmentId = "cached-environment" as import("@t3tools/contracts").EnvironmentId;
  const otherEnvironment = "other-environment" as import("@t3tools/contracts").EnvironmentId;

  async function sqliteDatabase() {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA user_version = 1");
    const database = {
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
      runAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).run(...args),
      getFirstAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).get(...args),
      getAllAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).all(...args),
      withExclusiveTransactionAsync: async (run: (transaction: unknown) => Promise<void>) => {
        await run(database);
      },
      closeAsync: async () => {
        sqlite.close();
      },
    };
    openDatabaseAsync.mockResolvedValueOnce(database);
    return sqlite;
  }

  it.effect("restores saved records and clears them with the environment", () =>
    Effect.gen(function* () {
      yield* Effect.promise(sqliteDatabase);
      const database = yield* MobileDatabase.make;
      yield* database.saveCache(environmentId, "pull-request", "v1:list", 1, '{"entries":[]}');
      yield* database.saveCache(otherEnvironment, "pull-request", "v1:list", 1, "other");
      expect(yield* database.loadCache(environmentId, "pull-request", "v1:list")).toEqual(
        Option.some('{"entries":[]}'),
      );
      yield* database.clearEnvironmentCache(environmentId);
      expect((yield* database.loadCache(environmentId, "pull-request", "v1:list"))._tag).toBe(
        "None",
      );
      expect((yield* database.loadCache(otherEnvironment, "pull-request", "v1:list"))._tag).toBe(
        "Some",
      );
    }),
  );

  it.effect(
    "filters eviction by row key and payload within the selected environment and kind",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(sqliteDatabase);
        const database = yield* MobileDatabase.make;
        yield* database.saveCache(environmentId, "vcs-refs", "/linked", 1, "affected");
        yield* database.saveCache(environmentId, "vcs-refs", "/stale", 1, "other");
        yield* database.saveCache(environmentId, "vcs-refs", "/unrelated", 1, "other");
        yield* database.saveCache(otherEnvironment, "vcs-refs", "/linked", 1, "affected");
        yield* database.saveCache(environmentId, "pull-request", "/linked", 1, "affected");

        yield* database.clearCacheKind(
          environmentId,
          "vcs-refs",
          (key, payload) => key === "/stale" || payload === "affected",
        );
        expect(yield* database.loadCache(environmentId, "vcs-refs", "/linked")).toEqual(
          Option.none(),
        );
        expect(yield* database.loadCache(environmentId, "vcs-refs", "/stale")).toEqual(
          Option.none(),
        );
        expect(yield* database.loadCache(environmentId, "vcs-refs", "/unrelated")).toEqual(
          Option.some("other"),
        );
        expect(yield* database.loadCache(otherEnvironment, "vcs-refs", "/linked")).toEqual(
          Option.some("affected"),
        );
        expect(yield* database.loadCache(environmentId, "pull-request", "/linked")).toEqual(
          Option.some("affected"),
        );
      }),
  );
});
