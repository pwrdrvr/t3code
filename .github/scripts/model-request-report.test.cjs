const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const {
  readArtifact,
  renderComment,
  resolve,
  validateResult,
  publish,
} = require("./model-request-report.cjs");

const headSha = "1".repeat(40);
const baseSha = "2".repeat(40);
const repo = { owner: "org", repo: "t3code" };
const source = {
  id: 12,
  event: "pull_request",
  repository: { id: 1 },
  workflow_id: 4,
  head_sha: headSha,
  head_branch: "topic",
  head_repository: { id: 2, owner: { login: "fork" } },
  run_number: 12,
  run_attempt: 1,
};
const pull = {
  number: 8,
  state: "open",
  base: { sha: baseSha, ref: "main", repo: { id: 1 } },
  head: { sha: headSha, ref: "topic", repo: { id: 2 } },
};

function result(bytes = 1000) {
  const turn = {
    bytes,
    calls: 1,
    primaryBytes: bytes,
    inputBytes: 50,
    instructionBytes: 200,
    toolBytes: 500,
    auxiliaryBytes: 0,
    auxiliaryCalls: 0,
  };
  return {
    version: 1,
    results: ["codex", "claude", "antigravity"].map((provider) => ({
      provider,
      observed: { first: { ...turn }, next: { ...turn } },
      ceilings: { first: { ...turn, bytes: 1100 }, next: { ...turn, bytes: 1100 } },
    })),
  };
}

test("rejects nonnumeric, structurally invalid or inconsistent fork results", () => {
  assert.deepEqual(validateResult(result()), result());
  for (const change of [
    (value) => {
      value.results[0].raw = "untrusted text";
    },
    (value) => {
      value.results[0].provider = "claude";
    },
    (value) => {
      value.results[1].observed.first.calls = 2;
    },
    (value) => {
      value.results[1].observed.first.bytes = "1000";
    },
    (value) => {
      value.results[2].observed.next.primaryBytes = 900;
    },
    (value) => {
      value.results[2].observed.next.toolBytes = -1;
    },
  ]) {
    const value = result();
    change(value);
    assert.equal(validateResult(value), undefined);
  }
});

test("reads a bounded ZIP member and rejects oversized decompressed content", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "t3-model-report-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const download = join(directory, "download");
  mkdirSync(download);
  const archive = join(download, "artifact.zip");
  const file = "model-request-result.json";
  writeFileSync(join(directory, file), JSON.stringify(result()));
  execFileSync("zip", ["-q", archive, file], { cwd: directory });
  assert.deepEqual(readArtifact(download), result());
  rmSync(archive);
  writeFileSync(join(directory, file), JSON.stringify(result()) + " ".repeat(100_000));
  execFileSync("zip", ["-q", archive, file], { cwd: directory });
  assert.equal(readArtifact(download), undefined);
});

test("renders exact byte deltas, exceeded budgets and a changed ceiling", () => {
  const current = result(1200);
  const baseline = result();
  current.results[0].ceilings.first.bytes = 1150;
  const report = {
    current,
    baseline,
    runBaseSha: baseSha,
    pullBaseSha: baseSha,
    source: { sha: headSha, id: 12, number: 12, attempt: 1, conclusion: "failure" },
    baselineRun: { sha: baseSha, id: 5 },
    runUrl: (id) => `https://github.com/org/t3code/actions/runs/${id}`,
  };
  const body = renderComment(report);
  assert.match(
    body,
    /Codex \| First turn \| Total body bytes \| 1,000 \| 1,200 \| \+200 \(\+20\.0%\) \| 1,150 \| ❌/,
  );
  assert.match(body, /Ceiling changes/);
  assert.match(body, /Primary request and auxiliary call breakdown/);
  assert.doesNotMatch(body, /latest available/);
  assert.match(
    renderComment({ ...report, runBaseSha: undefined }),
    /GitHub did not report the base for this CI run\. Deltas use the current PR base\./,
  );
  assert.match(
    renderComment({ ...report, runBaseSha: headSha }),
    /The exact base has no usable measurement/,
  );
  assert.match(
    renderComment({ ...report, baseline: undefined, runBaseSha: undefined }),
    /GitHub did not report the base for this CI run/,
  );
  assert.match(
    renderComment({ ...report, baseline: undefined }),
    /No usable `main` measurement was found for the CI run's base/,
  );
  assert.match(
    renderComment({ ...report, source: { ...report.source, attempt: 2, measurementAttempt: 1 } }),
    /Model measurement from attempt 1/,
  );
});

test("resolves fork heads without an associated PR and uses successful main baselines", async () => {
  const exactFilters = [];
  const outputs = {};
  const github = {
    paginate: async (_endpoint, filters) => {
      assert.equal(filters.head, "fork:topic");
      return [pull, { ...pull, head: { ...pull.head, sha: baseSha } }];
    },
    rest: {
      pulls: { list: () => {} },
      actions: {
        listWorkflowRunArtifacts: async ({ run_id, name }) => ({
          data: {
            artifacts: [
              {
                id: run_id + 100,
                name,
                expired: false,
                size_in_bytes: 100,
              },
            ],
          },
        }),
        listWorkflowRuns: async (filters) => {
          exactFilters.push(filters);
          return {
            data: {
              workflow_runs: [
                {
                  id: filters.head_sha ? 5 : 6,
                  head_sha: filters.head_sha ?? "3".repeat(40),
                  head_repository: { id: 1 },
                  run_attempt: 1,
                },
              ],
            },
          };
        },
      },
    },
  };
  await resolve({
    github,
    context: { repo, payload: { repository: source.repository, workflow_run: source } },
    core: {
      setOutput: (name, value) => {
        outputs[name] = value;
      },
    },
  });
  assert.deepEqual(outputs, {
    pull: 8,
    current_artifact: 112,
    current_attempt: 1,
    baseline_artifact: 105,
    baseline_run: 5,
    baseline_sha: baseSha,
    run_base_sha: "",
    pr_base_sha: baseSha,
  });
  const filters = {
    ...repo,
    workflow_id: 4,
    branch: "main",
    event: "push",
    status: "success",
    per_page: 10,
  };
  assert.deepEqual(exactFilters, [{ ...filters, head_sha: baseSha }, filters]);
});

test("uses an earlier attempt's artifact only if the benchmark did not rerun", async () => {
  for (const [artifactOnRetry, benchmarkReran, expected, expectedAttempt] of [
    [true, true, 102, 2],
    [false, true, "", ""],
    [false, false, 101, 1],
  ]) {
    const outputs = {};
    const listJobs = () => {};
    const github = {
      paginate: async (endpoint, filters) => {
        assert.equal(endpoint, listJobs);
        assert.equal(filters.attempt_number, 2);
        return benchmarkReran ? [{ name: "Model request budget" }] : [{ name: "Lint" }];
      },
      rest: {
        pulls: { get: async () => ({ data: pull }) },
        actions: {
          listJobsForWorkflowRunAttempt: listJobs,
          listWorkflowRunArtifacts: async ({ name }) => ({
            data: {
              artifacts: [
                { id: 101, name: "model-request-results-1", expired: false, size_in_bytes: 100 },
                ...(artifactOnRetry
                  ? [
                      {
                        id: 102,
                        name: "model-request-results-2",
                        expired: false,
                        size_in_bytes: 100,
                      },
                    ]
                  : []),
              ].filter((artifact) => artifact.name === name),
            },
          }),
          listWorkflowRuns: async () => ({ data: { workflow_runs: [] } }),
        },
      },
    };
    await resolve({
      github,
      context: {
        repo,
        payload: {
          repository: source.repository,
          workflow_run: {
            ...source,
            run_attempt: 2,
            pull_requests: [{ number: pull.number, base: { sha: baseSha } }],
          },
        },
      },
      core: {
        setOutput: (name, value) => {
          outputs[name] = value;
        },
      },
    });
    assert.equal(outputs.current_artifact, expected);
    assert.equal(outputs.current_attempt, expectedAttempt);
    assert.equal(outputs.run_base_sha, baseSha);
  }
});

test("does not publish after a head moves or replace an existing result with a missing report", async () => {
  let skipped = 0;
  let currentComments = [];
  const github = {
    paginate: async () => currentComments,
    rest: {
      pulls: { get: async () => ({ data: { ...pull, head: { ...pull.head, sha: baseSha } } }) },
      issues: {
        listComments: () => {},
        createComment: () => assert.fail("must not comment"),
        updateComment: () => assert.fail("must not edit"),
      },
    },
  };
  const args = {
    github,
    context: { repo, payload: { repository: source.repository, workflow_run: source } },
    core: {
      info: () => {
        skipped += 1;
      },
    },
  };
  await publish(args, { MODEL_REPORT_PULL: "8" });
  currentComments = [
    {
      body: `<!-- t3-model-request-report -->\n<!-- t3-model-request-run ${headSha} 11 1 result -->`,
      user: { login: "github-actions[bot]" },
    },
  ];
  await publish(args, { MODEL_REPORT_PULL: "8" });
  assert.equal(skipped, 2);
});
