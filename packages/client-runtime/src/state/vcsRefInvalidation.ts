import type { EnvironmentId, VcsRefreshStatusResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PartitionedSemaphore from "effect/PartitionedSemaphore";
import { Atom, type AtomRegistry } from "effect/reactivity";

import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as Persistence from "../platform/persistence.ts";
import type { RpcSession } from "../rpc/session.ts";

interface VcsRefsInvalidationTarget {
  readonly environmentId: EnvironmentId;
}

export interface CachedVcsRefsInvalidationTarget extends VcsRefsInvalidationTarget {
  readonly cwd: string;
}

interface VcsRefsCacheState {
  readonly revision: number;
  readonly persistedCacheReadable: boolean;
}

const stateByEnvironment = Atom.family((environmentId: EnvironmentId) =>
  Atom.make<VcsRefsCacheState>({
    revision: 0,
    persistedCacheReadable: true,
  }).pipe(Atom.keepAlive, Atom.withLabel(`environment-data:vcs:list-refs-state:${environmentId}`)),
);
const scopedRevisionsByEnvironment = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make({
    revision: 0,
    byCwd: new Map<string, number>(),
    byCommonDir: new Map<string, number>(),
  }).pipe(Atom.keepAlive),
);

interface LiveIdentity {
  readonly gitCommonDir: string;
  readonly session: symbol;
}

const listsByEnvironment = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make(() => new Map<string, LiveIdentity | undefined>()).pipe(Atom.keepAlive),
);
const sessionIds = new WeakMap<RpcSession, symbol>();
function sessionId(session: RpcSession) {
  const existing = sessionIds.get(session);
  if (existing !== undefined) return existing;
  const id = Symbol();
  sessionIds.set(session, id);
  return id;
}

const persistenceLock = PartitionedSemaphore.makeUnsafe<EnvironmentId>({ permits: 1 });

export function vcsRefsCacheStateAtom(target: VcsRefsInvalidationTarget) {
  return stateByEnvironment(target.environmentId);
}

function getRevision(global: VcsRefsCacheState, scoped: ReadonlyMap<string, number>, cwd: string) {
  return Math.max(global.revision, scoped.get(cwd) ?? 0);
}

const revisionByCwd = Atom.family((key: string) => {
  const [environmentId, cwd] = JSON.parse(key) as [EnvironmentId, string];
  return Atom.make((get) =>
    getRevision(
      get(stateByEnvironment(environmentId)),
      get(scopedRevisionsByEnvironment(environmentId)).byCwd,
      cwd,
    ),
  );
});

export function vcsRefsRevisionAtom({ environmentId, cwd }: CachedVcsRefsInvalidationTarget) {
  return revisionByCwd(JSON.stringify([environmentId, cwd]));
}

export function vcsRefsRepositoryRevision(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  gitCommonDir: string,
): number {
  return (
    registry.get(scopedRevisionsByEnvironment(environmentId)).byCommonDir.get(gitCommonDir) ?? 0
  );
}

export function trackVcsRefsList(
  registry: AtomRegistry.AtomRegistry,
  target: CachedVcsRefsInvalidationTarget,
): void {
  const lists = registry.get(listsByEnvironment(target.environmentId));
  if (!lists.has(target.cwd)) lists.set(target.cwd, undefined);
}

export function recordVcsRefsIdentity(
  registry: AtomRegistry.AtomRegistry,
  target: CachedVcsRefsInvalidationTarget,
  gitCommonDir: string | undefined,
  session: RpcSession,
): void {
  registry
    .get(listsByEnvironment(target.environmentId))
    .set(
      target.cwd,
      gitCommonDir === undefined ? undefined : { gitCommonDir, session: sessionId(session) },
    );
}

export function invalidateVcsRefs(
  registry: AtomRegistry.AtomRegistry,
  target: VcsRefsInvalidationTarget,
  persistedCacheReadable?: boolean,
): void {
  const scopedRevision = registry.get(scopedRevisionsByEnvironment(target.environmentId)).revision;
  registry.update(vcsRefsCacheStateAtom(target), (state) => ({
    revision: Math.max(state.revision, scopedRevision) + 1,
    persistedCacheReadable: persistedCacheReadable ?? state.persistedCacheReadable,
  }));
}

export function withVcsRefsPersistenceLock<A, E, R>(
  environmentId: EnvironmentId,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return persistenceLock.withPermit(environmentId)(effect);
}

// Clear first so restarted reads cannot rehydrate an invalidated snapshot.
const invalidate = Effect.fn("VcsRefsState.invalidate")(function* (
  registry: AtomRegistry.AtomRegistry,
  target: CachedVcsRefsInvalidationTarget,
  cache: Persistence.EnvironmentCacheStore["Service"],
  scope?: Persistence.VcsRefsCacheScope,
) {
  const stateAtom = vcsRefsCacheStateAtom(target);
  const state = registry.get(stateAtom);
  const persistedCacheReadable = yield* cache
    .clearVcsRefs(target.environmentId, state.persistedCacheReadable ? scope : undefined)
    .pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Could not remove invalidated cached Git refs.").pipe(
          Effect.annotateLogs({
            environmentId: target.environmentId,
            cwd: target.cwd,
            ...safeErrorLogAttributes(error),
          }),
          Effect.as(false),
        ),
      ),
    );
  if (scope === undefined) {
    invalidateVcsRefs(registry, target, persistedCacheReadable);
    return;
  }
  Atom.batch(() => {
    registry.update(scopedRevisionsByEnvironment(target.environmentId), (current) => {
      const revision = Math.max(current.revision, state.revision) + 1;
      const byCwd = new Map(current.byCwd);
      const byCommonDir = new Map(current.byCommonDir);
      for (const cwd of scope.cwds) byCwd.set(cwd, revision);
      for (const commonDir of scope.gitCommonDirs) byCommonDir.set(commonDir, revision);
      return { revision, byCwd, byCommonDir };
    });
    if (persistedCacheReadable !== state.persistedCacheReadable) {
      registry.set(stateAtom, { ...state, persistedCacheReadable });
    }
  });
});

export const invalidateCachedVcsRefs = Effect.fn("VcsRefsState.invalidateCached")(function* (
  registry: AtomRegistry.AtomRegistry,
  target: CachedVcsRefsInvalidationTarget,
) {
  const cache = yield* Persistence.EnvironmentCacheStore;
  yield* withVcsRefsPersistenceLock(target.environmentId, invalidate(registry, target, cache));
});

const refsDigestsByEnvironment = Atom.family((_environmentId: EnvironmentId) =>
  Atom.make(
    () =>
      new Map<
        string,
        {
          digest: string;
          gitCommonDir: string | undefined;
          session: symbol | undefined;
        }
      >(),
  ).pipe(Atom.keepAlive),
);

export const invalidateCachedVcsRefsIfChanged = Effect.fn("VcsRefsState.invalidateCachedIfChanged")(
  function* (
    registry: AtomRegistry.AtomRegistry,
    target: CachedVcsRefsInvalidationTarget,
    result: Pick<VcsRefreshStatusResult, "refsDigest" | "gitCommonDir"> | undefined,
    session: RpcSession | undefined,
  ) {
    const cache = yield* Persistence.EnvironmentCacheStore;
    yield* withVcsRefsPersistenceLock(
      target.environmentId,
      Effect.gen(function* () {
        const digests = registry.get(refsDigestsByEnvironment(target.environmentId));
        const lists = registry.get(listsByEnvironment(target.environmentId));
        const previous = digests.get(target.cwd);
        const oldCommonDir = lists.get(target.cwd)?.gitCommonDir;
        const id = session === undefined ? undefined : sessionId(session);
        const { refsDigest, gitCommonDir } = result ?? {};
        if (
          refsDigest !== undefined &&
          previous?.digest === refsDigest &&
          previous.gitCommonDir === gitCommonDir &&
          previous.session === id &&
          (gitCommonDir === undefined ||
            oldCommonDir === undefined ||
            oldCommonDir === gitCommonDir)
        ) {
          return;
        }
        if (refsDigest === undefined) digests.delete(target.cwd);
        else digests.set(target.cwd, { digest: refsDigest, gitCommonDir, session: id });

        if (gitCommonDir === undefined || id === undefined) {
          yield* invalidate(registry, target, cache);
          return;
        }
        const gitCommonDirs = new Set([gitCommonDir]);
        // Retargeting an alias can leave stale occupancy in the family it previously identified.
        if (oldCommonDir !== undefined) gitCommonDirs.add(oldCommonDir);
        if (previous?.gitCommonDir !== undefined) gitCommonDirs.add(previous.gitCommonDir);

        const cwds = new Set([target.cwd]);
        for (const [cwd, identity] of lists) {
          if (identity?.session !== id || gitCommonDirs.has(identity.gitCommonDir)) {
            cwds.add(cwd);
          }
        }
        yield* invalidate(registry, target, cache, { cwds, gitCommonDirs });
      }),
    );
  },
);
