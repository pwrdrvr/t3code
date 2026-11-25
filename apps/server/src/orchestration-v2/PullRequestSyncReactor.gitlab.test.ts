import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type OrchestrationProjectShell,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as FeatureFlags from "@t3tools/shared/FeatureFlags";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import { driver } from "@t3tools/source-control-gitlab/server/driver";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import * as GitManager from "../git/GitManager.ts";
import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PullRequestProviderRegistry from "../pullRequest/PullRequestProviderRegistry.ts";
import * as PullRequestReadCache from "../pullRequest/PullRequestReadCache.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as PullRequestSyncReactor from "./PullRequestSyncReactor.ts";

const START = "2026-08-28T12:00:00.000Z";
const GITLAB = SourceControlProviderKind.make("gitlab");
const HOST = "gitlab.example.test";

function recordedProcess(stdout: string, code = 0, stderr = ""): ProcessRunner.ProcessRunOutput {
  return {
    stdout,
    stderr,
    code: ChildProcessSpawner.ExitCode(code),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  };
}

function page(
  body: unknown,
  options?: {
    readonly status?: number;
    readonly header?: string;
    readonly code?: number;
  },
) {
  const { status = 200, header = "Content-Type: application/json", code = 0 } = options ?? {};
  return recordedProcess(
    `HTTP/2.0 ${status} Response\n${header}\r\n\r\n${JSON.stringify(body)}`,
    code,
  );
}

function node(repository: string, iid: string, host = HOST) {
  return {
    iid,
    title: `${repository}!${iid}`,
    webUrl: `https://${host}/${repository}/-/merge_requests/${iid}`,
    sourceBranch: `fork-branch-${iid}`,
    targetBranch: "main",
    state: "OPENED",
    draft: true,
    updatedAt: START,
    closedAt: null,
    mergedAt: null as string | null,
    conflicts: false,
    mergeStatusEnum: "CAN_BE_MERGED",
    detailedMergeStatus: "NEED_REBASE",
    author: { username: "alice", name: "Alice", avatarUrl: "/uploads/avatar.png" },
    approved: false,
    approvedBy: { nodes: [{ username: "bot" }] },
    reviewers: { nodes: [{ mergeRequestInteraction: { reviewState: "REQUESTED_CHANGES" } }] },
    headPipeline: { status: "SUCCESS" },
    diffStatsSummary: { additions: 5, deletions: 2, fileCount: 1 },
  };
}

function graphPage(
  nodes: ReadonlyArray<ReturnType<typeof node> | null>,
  next: string | null = null,
) {
  return page({
    data: {
      metadata: { enterprise: true },
      project: {
        mergeRequests: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } },
      },
    },
  });
}

function restRow(repository: string, number: number, state = "opened") {
  return {
    iid: number,
    title: `REST !${number}`,
    web_url: `https://${HOST}/${repository}/-/merge_requests/${number}`,
    source_branch: "fork-branch",
    target_branch: "main",
    source_project_id: 32,
    target_project_id: 19,
    state,
    draft: false,
    created_at: START,
    updated_at: START,
    closed_at: state === "closed" ? START : null,
    merge_status: "can_be_merged",
    detailed_merge_status: "mergeable",
    changes_count: "2",
  };
}

function batch(input: ProcessRunner.ProcessRunInput) {
  const parsed = JSON.parse(input.stdin ?? "{}") as {
    readonly query: string;
    readonly variables: {
      readonly fullPath: string;
      readonly iids: ReadonlyArray<string>;
      readonly first: number;
      readonly after: string | null;
    };
  };
  assert.include(parsed.query, "query LinkedMergeRequestSummaries");
  assert.include(input.args, "--include");
  return parsed.variables;
}

function linkedPage({ fullPath, iids, first, after }: ReturnType<typeof batch>) {
  const start = after === null ? 0 : Number(after);
  const end = start + first;
  return graphPage(
    iids.slice(start, end).map((iid) => node(fullPath, iid)),
    end < iids.length ? String(end) : null,
  );
}

function benchmarkReply(input: ProcessRunner.ProcessRunInput) {
  if (input.args.includes("--include")) {
    return linkedPage(batch(input));
  }
  const path = input.args[1] ?? "";
  const detail = /projects\/([^/]+)\/merge_requests\/(\d+)/u.exec(path);
  const response = (body: unknown) => recordedProcess(JSON.stringify(body));
  if (detail !== null) {
    const number = Number(detail[2]);
    return response({
      ...restRow(decodeURIComponent(detail[1]!), number),
      description: "Description",
      head_pipeline: { id: 1000 + number, project_id: 32, status: "success" },
    });
  }
  assert.equal(path, "graphql");
  const { query, variables } = JSON.parse(input.stdin ?? "{}") as {
    readonly query: string;
    readonly variables: { readonly iids?: ReadonlyArray<string> };
  };
  if (query.includes("adminMergeRequest")) {
    return response({
      data: { project: { mergeRequest: { userPermissions: { adminMergeRequest: true } } } },
    });
  }
  if (query.includes("stages(first:")) {
    return response({
      data: {
        project: {
          mergeRequest: {
            headPipeline: {
              stages: {
                nodes: [{ name: "test", jobs: { nodes: [{ name: "unit", status: "SUCCESS" }] } }],
              },
            },
          },
        },
      },
    });
  }
  assert.isTrue(query.includes("diffStatsSummary") || query.includes("approvedBy"));
  return response({
    data: {
      metadata: { enterprise: true },
      project: {
        mergeRequests: {
          nodes: (variables.iids ?? []).map((iid) => node("team/repo-0", iid)),
        },
      },
    },
  });
}

function repo(
  repository: string,
  numbers: ReadonlyArray<number>,
  options?: {
    readonly host?: string;
    readonly id?: string;
    readonly cwd?: string;
  },
) {
  const host = options?.host ?? HOST;
  const id = options?.id ?? repository;
  const cwd = options?.cwd ?? `/workspace/${id}`;
  const project: OrchestrationProjectShell = {
    id: ProjectId.make(id),
    title: id,
    workspaceRoot: cwd,
    repositoryIdentity: {
      canonicalKey: `${host}/${repository}`,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: `https://${host}/${repository}.git`,
      },
      provider: GITLAB,
      displayName: repository,
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: START,
    updatedAt: START,
  };
  const links = numbers.map((number): ThreadPullRequestLink => ({
    host,
    repository,
    number,
    url: `https://${host}/${repository}/-/merge_requests/${number}`,
    source: "manual",
    linkedAt: START,
    snapshot: null,
    stack: null,
  }));
  return { project, links };
}

const makeFixture = Effect.fn("makeGitLabSyncFixture")(function* (
  repositories: ReadonlyArray<ReturnType<typeof repo>>,
  run: (input: ProcessRunner.ProcessRunInput) => Effect.Effect<ProcessRunner.ProcessRunOutput>,
) {
  yield* TestClock.setTime(Date.parse(START));
  const snapshotReads = yield* Queue.unbounded<void>();
  let threads = repositories.flatMap(({ project, links }) =>
    links.map((link): ProjectionStore.ProjectionThreadPullRequests => {
      const id = ThreadId.make(`${project.id}!${link.number}`);
      return {
        id,
        projectId: project.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
        settledOverride: null,
        settledAt: null,
        pullRequests: [link],
      };
    }),
  );
  const limits = yield* SourceControlRateLimit.make;
  const vcs = yield* VcsProcess.make.pipe(
    Effect.provideService(ProcessRunner.ProcessRunner, { run }),
    Effect.provideService(HostProcess.Environment, {}),
  );
  const gitlab = yield* driver.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        TestSourceControlHost.layer({ process: { run: vcs.run } }),
        FileSystem.layerNoop({}),
        NodeCrypto.layer,
        FeatureFlags.layerTest(),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected HTTP request.")),
        ),
      ),
    ),
    Effect.provideService(HostProcess.Environment, {}),
    Effect.provideService(SourceControlRateLimit.SourceControlRateLimit, limits),
  );
  const projects = repositories.map(({ project }) => project);
  const pullRequests = yield* PullRequestService.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        Layer.succeed(
          PullRequestProviderRegistry.PullRequestProviderRegistry,
          PullRequestProviderRegistry.fromProviders([gitlab.pullRequests!]),
        ),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          get: () => Effect.succeed(gitlab.sourceControl!),
          resolveLink: () => undefined,
        }),
        Layer.mock(ProjectService.ProjectService)({
          listShells: () => Effect.succeed(projects),
          getShell: (id) =>
            Effect.succeed(Option.fromNullishOr(projects.find((project) => project.id === id))),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(null),
        }),
        Layer.succeed(SourceControlRateLimit.SourceControlRateLimit, limits),
        PullRequestFilesViewed.layer.pipe(Layer.provide(Sqlite.layerMemory)),
        Layer.effect(PullRequestReadCache.PullRequestReadCache, PullRequestReadCache.make).pipe(
          Layer.provide(KeyValueStore.layerMemory),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
  const crypto = SecureRandom.make((size) => new Uint8Array(size).fill(7));
  const seen = new Map<ThreadId, ThreadPullRequestLink["snapshot"]>();
  const reactor = yield* PullRequestSyncReactor.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(PullRequestService.PullRequestService, pullRequests),
        Layer.succeed(SecureRandom.SecureRandom, crypto),
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "thread.pull-request-link.sync") {
                seen.set(command.threadId, command.snapshot);
                threads = threads.map((thread) =>
                  thread.id === command.threadId
                    ? {
                        ...thread,
                        pullRequests: (thread.pullRequests ?? []).map((link) => ({
                          ...link,
                          snapshot: command.snapshot,
                          stack: command.stack,
                        })),
                      }
                    : thread,
                );
              }
              return { sequence: seen.size, storedEvents: [] };
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadsWithPullRequests: () =>
            Queue.offer(snapshotReads, undefined).pipe(Effect.as(threads)),
        }),
        Layer.mock(GitManager.GitManager)({
          subscribePullRequestStateChanges: Effect.succeed(Stream.empty),
        }),
      ),
    ),
  );
  const activation = yield* Deferred.make<void>();
  yield* reactor
    .start()
    .pipe(Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)));
  yield* Deferred.succeed(activation, undefined);
  yield* Queue.take(snapshotReads);
  return { reactor, pullRequests, limits, seen, snapshotReads };
});

describe("GitLab linked merge request sync", () => {
  it.effect.each([
    [1, 1, 1],
    [40, 1, 1],
    [40, 4, 4],
    [400, 1, 12],
    [400, 4, 12],
  ] as const)(
    "batches %i linked MRs in %i repositories into %i calls per sweep",
    ([count, repos, calls]) =>
      Effect.gen(function* () {
        const repositories = Array.from({ length: repos }, (_, index) =>
          repo(
            `team/repo-${index}`,
            Array.from({ length: count / repos }, (_, number) => number + 1),
          ),
        );
        const batches: ReturnType<typeof batch>[] = [];
        const fixture = yield* makeFixture(repositories, (input) =>
          Effect.sync(() => {
            const variables = batch(input);
            batches.push(variables);
            return linkedPage(variables);
          }),
        );
        yield* fixture.reactor.drain;
        assert.lengthOf(batches, calls);
        assert.isTrue(batches.every(({ first }) => first <= 40));
        assert.lengthOf(
          batches.filter(({ after }) => after === null),
          Math.ceil(count / repos / 100) * repos,
        );
        assert.equal(fixture.seen.size, count);
        const snapshot = fixture.seen.get(ThreadId.make("team/repo-0!1"));
        assert.include(snapshot!, {
          title: "team/repo-0!1",
          headBranch: "fork-branch-1",
          baseBranch: "main",
          state: "open",
          isDraft: true,
          reviewDecision: "changes-requested",
          checksState: "passing",
          rebaseRequired: true,
          mergeability: "mergeable",
          additions: 5,
          deletions: 2,
          changedFiles: 1,
        });
        assert.equal(snapshot?.author?.avatarUrl, `https://${HOST}/uploads/avatar.png`);

        yield* TestClock.adjust("1 minute");
        yield* Queue.take(fixture.snapshotReads);
        yield* fixture.reactor.drain;
        assert.lengthOf(batches, calls * 2);
      }),
  );

  it.effect("uses target repositories and cursors, keeping missing IIDs isolated", () =>
    Effect.gen(function* () {
      const repositories = [
        repo("team/target", [1, 2, 3]),
        repo("team/target", [1], { id: "same-checkout", cwd: "/workspace/team/target" }),
        repo("team/target", [1], { id: "different-checkout" }),
        repo("team/target", [1], { id: "different-host", host: "other.example.test" }),
      ];
      const observed: Array<readonly [string | undefined, string | null]> = [];
      const fixture = yield* makeFixture(repositories, (input) =>
        Effect.sync(() => {
          const { iids, after, fullPath } = batch(input);
          observed.push([input.cwd, after]);
          const first = node(fullPath, "1", input.env?.GITLAB_HOST);
          if (iids.length === 1) return graphPage([{ ...first, title: input.cwd ?? "" }]);
          return after === null
            ? graphPage([first, null], "next-cursor")
            : graphPage([
                {
                  ...node(fullPath, "2"),
                  state: "MERGED",
                  mergedAt: START,
                },
              ]);
        }),
      );
      yield* fixture.reactor.drain;
      assert.sameDeepMembers(observed, [
        ["/workspace/team/target", null],
        ["/workspace/team/target", "next-cursor"],
        ["/workspace/different-checkout", null],
        ["/workspace/different-host", null],
      ]);
      assert.equal(fixture.seen.get(ThreadId.make("team/target!1"))?.headBranch, "fork-branch-1");
      assert.equal(fixture.seen.get(ThreadId.make("team/target!2"))?.mergedAt, START);
      assert.isFalse(fixture.seen.has(ThreadId.make("team/target!3")));
      assert.equal(fixture.seen.get(ThreadId.make("same-checkout!1"))?.headBranch, "fork-branch-1");
      assert.equal(
        fixture.seen.get(ThreadId.make("different-checkout!1"))?.title,
        "/workspace/different-checkout",
      );
      assert.equal(
        fixture.seen.get(ThreadId.make("different-host!1"))?.title,
        "/workspace/different-host",
      );
    }),
  );

  it.effect(
    "uses paged REST lists on older GitLab and keeps forced refresh on the full summary",
    () =>
      Effect.gen(function* () {
        const repository = repo("team/target", [1, 2, 3]);
        const calls: string[] = [];
        const fixture = yield* makeFixture([repository], (input) =>
          Effect.sync(() => {
            const path = input.args[1] ?? "";
            calls.push(path);
            if (path === "graphql") {
              if (!input.args.includes("--include")) return recordedProcess("{}");
              if (input.stdin?.includes("LinkedMergeRequestSummaries")) {
                return page(
                  { errors: [{ message: "Field 'closedAt' does not exist" }] },
                  { code: 1 },
                );
              }
              assert.include(input.stdin, '"iids":["1","2"]');
              const withStats = input.stdin?.includes("diffStatsSummary") === true;
              const nodes = ["1", "2"].map((iid) => {
                const { approved, approvedBy, reviewers, headPipeline, diffStatsSummary } = node(
                  "team/target",
                  iid,
                );
                return withStats
                  ? { iid, diffStatsSummary }
                  : { iid, approved, approvedBy, reviewers, headPipeline };
              });
              return page({
                data: { metadata: { enterprise: true }, project: { mergeRequests: { nodes } } },
              });
            }
            const url = new URL(path, `https://${HOST}/`);
            if (url.pathname.endsWith("/merge_requests/1")) {
              return recordedProcess(
                JSON.stringify({ ...restRow("team/target", 1), title: "Manual detail" }),
              );
            }
            assert.deepEqual(url.searchParams.getAll("iids[]"), ["1", "2", "3"]);
            assert.equal(url.searchParams.get("scope"), "all");
            assert.equal(url.searchParams.get("state"), "all");
            return url.searchParams.get("page") === "1"
              ? page([restRow("team/target", 1)], { header: "X-Next-Page: 2" })
              : page([restRow("team/target", 2, "closed")], { header: "X-Next-Page:" });
          }),
        );
        yield* fixture.reactor.drain;
        assert.lengthOf(calls, 5);
        assert.deepInclude(fixture.seen.get(ThreadId.make("team/target!2")), {
          state: "closed",
          closedAt: START,
          changedFiles: 1,
          additions: 5,
          deletions: 2,
          reviewDecision: "changes-requested",
          checksState: "passing",
        });
        assert.isFalse(fixture.seen.has(ThreadId.make("team/target!3")));

        yield* fixture.reactor.requestSync({ host: HOST, repository: "team/target", number: 1 });
        yield* fixture.reactor.drain;
        assert.isTrue(calls.slice(5).some((path) => path.includes("/merge_requests/1?")));
        assert.equal(fixture.seen.get(ThreadId.make("team/target!1"))?.title, "Manual detail");
      }),
  );

  it.effect("restarts REST pagination at a smaller size after a truncated later page", () =>
    Effect.gen(function* () {
      const pages: Array<readonly [number, number]> = [];
      const repository = repo("team/target", [1, 2, 3, 4]);
      const fixture = yield* makeFixture([repository], (input) =>
        Effect.sync(() => {
          const path = input.args[1] ?? "";
          if (path === "graphql") {
            return page({ errors: [{ message: "Unsupported query" }] }, { code: 1 });
          }
          const url = new URL(path, `https://${HOST}/`);
          const size = Number(url.searchParams.get("per_page"));
          const number = Number(url.searchParams.get("page"));
          pages.push([size, number]);
          if (size === 4 || (size === 2 && number === 2)) {
            return { ...page(null), stdoutTruncated: true };
          }
          const start = (number - 1) * size + 1;
          return page(
            Array.from({ length: size }, (_, offset) => restRow("team/target", start + offset)),
            {
              header: `X-Next-Page: ${start + size <= 4 ? number + 1 : ""}`,
            },
          );
        }),
      );
      yield* fixture.reactor.drain;
      assert.deepEqual(pages, [
        [4, 1],
        [2, 1],
        [2, 2],
        [1, 1],
        [1, 2],
        [1, 3],
        [1, 4],
      ]);
      assert.equal(fixture.seen.size, 4);
    }),
  );

  it.effect.each(["REST page", "enrichment"] as const)(
    "stops the REST fallback when its %s is throttled and retains a date Retry-After",
    (phase) =>
      Effect.gen(function* () {
        const repository = repo("team/target", [1, 2, 3]);
        const deadline = Date.parse(START) + 121_000;
        const calls: string[] = [];
        const fixture = yield* makeFixture([repository], (input) =>
          Effect.sync(() => {
            const path = input.args[1] ?? "";
            calls.push(path);
            if (input.stdin?.includes("LinkedMergeRequestSummaries")) {
              return page({ errors: [{ message: "Unsupported query" }] }, { code: 1 });
            }
            if (phase === "enrichment" && path !== "graphql") {
              return page([restRow("team/target", 1)]);
            }
            return page([], {
              status: 429,
              header: "Retry-After: Fri, 28 Aug 2026 12:02:01 GMT",
              code: 1,
            });
          }),
        );
        yield* fixture.reactor.drain;
        const attempts = phase === "REST page" ? 2 : 3;
        assert.lengthOf(calls, attempts);
        assert.include(calls[1], "page=1");
        assert.equal(fixture.seen.size, 0);
        const ref = {
          projectId: repository.project.id,
          host: HOST,
          repository: "team/target",
          number: 1,
        };
        const read = yield* fixture.pullRequests.prepareLinkedSummaryReads([ref]);
        expect(yield* Effect.result(read(ref)!)).toMatchObject({
          _tag: "Failure",
          failure: {
            cause: { _tag: "PullRequestProviderError", reason: "rate-limited", retryAt: deadline },
          },
        });
        assert.lengthOf(calls, attempts);
      }),
  );

  it.effect("rechecks queued launches and resumes after the provider deadline", () =>
    Effect.gen(function* () {
      const repositories = Array.from({ length: 5 }, (_, index) => repo(`team/repo-${index}`, [1]));
      const launches = yield* Queue.unbounded<string>();
      const firstResponse = yield* Deferred.make<void>();
      const otherResponses = yield* Deferred.make<void>();
      let attempts = 0;
      const fixture = yield* makeFixture(
        repositories,
        Effect.fnUntraced(function* (input) {
          const { fullPath } = batch(input);
          const attempt = ++attempts;
          yield* Queue.offer(launches, fullPath);
          if (attempt === 1) {
            yield* Deferred.await(firstResponse);
            return page(
              { message: "throttled" },
              { status: 429, header: "Retry-After: 121", code: 1 },
            );
          }
          if (attempt <= 3) yield* Deferred.await(otherResponses);
          return graphPage([node(fullPath, "1")]);
        }),
      );
      yield* Queue.takeBetween(launches, 3, 3);
      yield* Deferred.succeed(firstResponse, undefined);
      yield* TestClock.adjust("1 millis");
      const denied = yield* Effect.result(fixture.limits.check({ provider: GITLAB, host: HOST }));
      assert.match(denied._tag, /^Failure$/);
      if (denied._tag === "Failure")
        assert.equal(denied.failure.retryAt, Date.parse(START) + 121_000);
      yield* Deferred.succeed(otherResponses, undefined);
      yield* fixture.reactor.drain;
      assert.equal(attempts, 3);
      for (let minute = 0; minute < 2; minute++) {
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(fixture.snapshotReads);
        yield* fixture.reactor.drain;
        assert.equal(attempts, 3);
      }
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(fixture.snapshotReads);
      yield* fixture.reactor.drain;
      assert.equal(attempts, 8);
      assert.equal(fixture.seen.size, 5);
    }),
  );
});

const writeBenchmarkResult = (result: unknown) =>
  process.stdout.write(`${JSON.stringify(result)}\n`);

if (process.env.T3_GITLAB_SYNC_BENCHMARK === "1") {
  it.effect("measures GitLab linked sync at 25 ms simulated transport latency", () =>
    Effect.gen(function* () {
      for (const [count, repos] of [
        [1, 1],
        [40, 1],
        [40, 4],
        [400, 1],
        [400, 4],
      ] as const) {
        const repositories = Array.from({ length: repos }, (_, index) =>
          repo(
            `team/repo-${index}`,
            Array.from({ length: count / repos }, (_, number) => number + 1),
          ),
        );
        type Attempt = { started: number; finished: number; inFlight: number; bytes: number };
        let records: Attempt[] = [];
        let inFlight = 0;
        const fixture = yield* makeFixture(
          repositories,
          Effect.fnUntraced(function* (input) {
            const started = yield* Clock.currentTimeMillis;
            const concurrent = ++inFlight;
            yield* Effect.sleep("25 millis");
            const output = benchmarkReply(input);
            const finished = yield* Clock.currentTimeMillis;
            records.push({
              started,
              finished,
              inFlight: concurrent,
              bytes: Buffer.byteLength(
                `${input.args.join(" ")}\n${input.stdin ?? ""}${output.stdout}${output.stderr}`,
              ),
            });
            inFlight--;
            return output;
          }),
        );
        yield* TestClock.adjust("30 seconds");
        yield* fixture.reactor.drain;
        assert.equal(fixture.seen.size, count);
        const cold = records;
        records = [];
        yield* TestClock.adjust("68 seconds");
        yield* Queue.take(fixture.snapshotReads);
        yield* fixture.reactor.drain;
        for (const [sweep, attempts] of [
          ["cold", cold],
          ["warm", records],
        ] as const) {
          assert.isAbove(attempts.length, 0);
          writeBenchmarkResult({
            linkedMRs: count,
            repositories: repos,
            sweep,
            glabAttempts: attempts.length,
            peak: Math.max(...attempts.map(({ inFlight }) => inFlight)),
            fixtureBytes: attempts.reduce((total, { bytes }) => total + bytes, 0),
            simulatedMs:
              Math.max(...attempts.map(({ finished }) => finished)) -
              Math.min(...attempts.map(({ started }) => started)),
          });
        }
      }
    }),
  );
}
