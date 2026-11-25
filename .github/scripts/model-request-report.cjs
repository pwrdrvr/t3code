const { spawnSync } = require("node:child_process");
const { readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");

const ARTIFACT = "model-request-results";
const FILE = "model-request-result.json";
const MARKER = "<!-- t3-model-request-report -->";
const MAX_BYTES = 32 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const PROVIDERS = { codex: "Codex", claude: "Claude", antigravity: "Antigravity" };
const PHASES = { first: "First turn", next: "Follow-up" };
const METRICS = {
  bytes: "Total body bytes",
  calls: "Model calls",
  primaryBytes: "Primary body bytes",
  inputBytes: "Input and history bytes",
  instructionBytes: "Instruction bytes",
  toolBytes: "Tool definition bytes",
  auxiliaryBytes: "Auxiliary body bytes",
  auxiliaryCalls: "Auxiliary calls",
};
const HEADLINE_METRICS = ["bytes", "calls"];

function hasKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    keys.length === Object.keys(value).length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validPhases(value) {
  return (
    hasKeys(value, Object.keys(PHASES)) &&
    Object.values(value).every(
      (phase) =>
        hasKeys(phase, Object.keys(METRICS)) &&
        Object.values(phase).every(
          (measure) => Number.isSafeInteger(measure) && measure >= 0 && measure < 1_000_000_000,
        ),
    )
  );
}

function validateResult(value) {
  if (
    !hasKeys(value, ["version", "results"]) ||
    value.version !== 1 ||
    !Array.isArray(value.results) ||
    value.results.length !== Object.keys(PROVIDERS).length
  )
    return undefined;
  const seen = new Set();
  for (const row of value.results) {
    if (
      !hasKeys(row, ["provider", "observed", "ceilings"]) ||
      typeof row.provider !== "string" ||
      !Object.hasOwn(PROVIDERS, row.provider) ||
      seen.has(row.provider) ||
      !validPhases(row.observed) ||
      !validPhases(row.ceilings)
    )
      return undefined;
    for (const phase of Object.values(row.observed)) {
      if (
        phase.calls !== phase.auxiliaryCalls + 1 ||
        phase.bytes !== phase.primaryBytes + phase.auxiliaryBytes ||
        phase.primaryBytes === 0 ||
        phase.inputBytes === 0 ||
        Math.max(phase.inputBytes, phase.instructionBytes, phase.toolBytes) > phase.primaryBytes ||
        (phase.auxiliaryCalls === 0) !== (phase.auxiliaryBytes === 0)
      )
        return undefined;
    }
    seen.add(row.provider);
  }
  return value;
}

function readArtifact(directory) {
  if (!directory) return undefined;
  try {
    const files = readdirSync(directory, { withFileTypes: true });
    if (files.length !== 1 || !files[0].isFile() || !files[0].name.endsWith(".zip"))
      return undefined;
    const archive = join(directory, files[0].name);
    if (statSync(archive).size > MAX_BYTES) return undefined;
    // Stream the named member with bounded output. Never extract fork archives to disk.
    const result = spawnSync("/usr/bin/unzip", ["-p", archive, FILE], {
      encoding: "utf8",
      maxBuffer: MAX_BYTES,
      timeout: 5_000,
    });
    if (result.status !== 0 || result.error) return undefined;
    return validateResult(JSON.parse(result.stdout));
  } catch {
    return undefined;
  }
}

function format(value) {
  return value === undefined ? "—" : value.toLocaleString("en-US");
}

function impact(current, baseline) {
  if (baseline === undefined) return "—";
  const delta = current - baseline;
  if (delta === 0) return "0";
  const sign = delta > 0 ? "+" : "−";
  const percent =
    baseline === 0 ? "" : ` (${sign}${((Math.abs(delta) / baseline) * 100).toFixed(1)}%)`;
  return `${sign}${format(Math.abs(delta))}${percent}`;
}

function renderComment({ current, baseline, source, baselineRun, exactBase, runUrl }) {
  const stamp = `<!-- t3-model-request-run ${source.sha} ${source.number} ${source.attempt} ${current ? "result" : "missing"} -->`;
  const lines = [MARKER, stamp, "## Model request impact", ""];
  const sourceLink = `[\`${source.sha.slice(0, 7)}\`](${runUrl(source.id)})`;
  if (!current) {
    lines.push(
      `⚠️ [CI](${runUrl(source.id)}) did not produce a usable model request measurement for \`${source.sha.slice(0, 7)}\`.`,
    );
    return lines.join("\n");
  }

  const currentByProvider = new Map(current.results.map((row) => [row.provider, row]));
  const baselineByProvider = new Map(baseline?.results.map((row) => [row.provider, row]));
  let failed = false;
  const changes = [];
  const rows = [];
  for (const [provider, name] of Object.entries(PROVIDERS)) {
    const { observed, ceilings } = currentByProvider.get(provider);
    const prior = baselineByProvider.get(provider);
    for (const [phase, title] of Object.entries(PHASES)) {
      for (const [metric, label] of Object.entries(METRICS)) {
        const value = observed[phase][metric];
        const limit = ceilings[phase][metric];
        const base = prior?.observed[phase][metric];
        const pass = value <= limit;
        failed ||= !pass;
        rows.push({
          headline: HEADLINE_METRICS.includes(metric),
          line: `| ${name} | ${title} | ${label} | ${format(base)} | ${format(value)} | ${impact(value, base)} | ${format(limit)} | ${pass ? "✅" : "❌"} |`,
        });
        const previousLimit = prior?.ceilings[phase][metric];
        if (previousLimit !== undefined && previousLimit !== limit) {
          changes.push(
            `- ${name} · ${title} · ${label} from ${format(previousLimit)} to ${format(limit)}`,
          );
        }
      }
    }
  }
  const header = [
    "| Provider | Turn | Metric | Main baseline | This PR | Impact | PR ceiling | Status |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | :---: |",
  ];
  lines.push(
    failed
      ? "❌ Measurements exceeded one or more ceilings."
      : "✅ All measurements stayed within their ceilings.",
    "",
  );
  if (!baseline) {
    lines.push(
      "> A successful `main` baseline is unavailable. CI still checks the PR ceilings.",
      "",
    );
  } else if (!exactBase) {
    lines.push(
      "> Deltas use the latest available successful `main` measurement. The exact base has no usable measurement.",
      "",
    );
  }
  lines.push(
    ...header,
    ...rows.filter(({ headline }) => headline).map(({ line }) => line),
    "",
    "<details>",
    "<summary>Primary request and auxiliary call breakdown</summary>",
    "",
    ...header,
    ...rows.filter(({ headline }) => !headline).map(({ line }) => line),
    "",
    "</details>",
    "",
  );
  if (changes.length > 0) lines.push("**Ceiling changes**", "", ...changes, "");
  const baselineLink = baseline
    ? `[\`${baselineRun.sha.slice(0, 7)}\`](${runUrl(baselineRun.id)})`
    : "unavailable";
  lines.push(
    "Real agent processes sent these HTTP request bodies to synthetic loopback model endpoints. Totals include auxiliary model calls.",
    "",
    `Baseline ${baselineLink} · PR ${sourceLink} · Source CI ${source.conclusion}`,
  );
  return lines.join("\n");
}

function matchesPull(pull, source, repositoryId) {
  return (
    pull.state === "open" &&
    pull.base.ref === "main" &&
    pull.base.repo?.id === repositoryId &&
    pull.head.repo?.id === source.head_repository?.id &&
    pull.head.ref === source.head_branch &&
    pull.head.sha === source.head_sha
  );
}

async function findPull(github, context, source) {
  const repositoryId = context.payload.repository.id;
  if (!source.head_repository?.id || !source.head_branch || !SHA.test(source.head_sha))
    return undefined;
  const associated = source.pull_requests ?? [];
  if (associated.length === 1) {
    const { data: pull } = await github.rest.pulls.get({
      ...context.repo,
      pull_number: associated[0].number,
    });
    return matchesPull(pull, source, repositoryId) ? pull : undefined;
  }
  // workflow_run often omits pull_requests for a fork head.
  const pulls = await github.paginate(github.rest.pulls.list, {
    ...context.repo,
    state: "open",
    head: `${source.head_repository.owner.login}:${source.head_branch}`,
    base: "main",
    per_page: 100,
  });
  const matching = pulls.filter((pull) => matchesPull(pull, source, repositoryId));
  return matching.length === 1 ? matching[0] : undefined;
}

async function artifactForRun(github, repo, runId) {
  const { data } = await github.rest.actions.listWorkflowRunArtifacts({
    ...repo,
    run_id: runId,
    name: ARTIFACT,
    per_page: 100,
  });
  const found = data.artifacts.filter(({ name, expired }) => name === ARTIFACT && !expired);
  const [artifact] = found;
  return found.length === 1 && artifact.size_in_bytes <= MAX_BYTES ? artifact : undefined;
}

async function resolve({ github, context, core }) {
  const source = context.payload.workflow_run;
  if (source.event !== "pull_request" || source.repository?.id !== context.payload.repository.id) {
    return core.info("This run did not measure a pull request in this repository.");
  }
  const pull = await findPull(github, context, source);
  if (!pull) return core.info("No current pull request into main matches this CI run.");

  const current = await artifactForRun(github, context.repo, source.id);
  const baseSha = source.pull_requests?.find(({ number }) => number === pull.number)?.base?.sha;
  const runs = async (filters) => {
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...context.repo,
      workflow_id: source.workflow_id,
      branch: "main",
      event: "push",
      status: "success",
      per_page: 10,
      ...filters,
    });
    return data.workflow_runs;
  };
  const [exact, recent] = current
    ? await Promise.all([baseSha && SHA.test(baseSha) ? runs({ head_sha: baseSha }) : [], runs({})])
    : [[], []];
  const candidates = new Map([...exact, ...recent].map((run) => [run.id, run]));
  let baseline;
  for (const run of candidates.values()) {
    if (run.head_repository?.id !== context.payload.repository.id || !SHA.test(run.head_sha))
      continue;
    const artifact = await artifactForRun(github, context.repo, run.id);
    if (artifact) {
      baseline = { id: run.id, sha: run.head_sha, artifactId: artifact.id };
      break;
    }
  }
  core.setOutput("pull", pull.number);
  core.setOutput("current_artifact", current?.id ?? "");
  core.setOutput("baseline_artifact", baseline?.artifactId ?? "");
  core.setOutput("baseline_run", baseline?.id ?? "");
  core.setOutput("baseline_sha", baseline?.sha ?? "");
  core.setOutput("exact_base", Boolean(baseline && baseline.sha === baseSha));
}

async function publish({ github, context, core }, env = process.env) {
  const run = context.payload.workflow_run;
  const pullNumber = Number(env.MODEL_REPORT_PULL);
  const current = readArtifact(env.MODEL_REPORT_PR_DIR);
  const baseline = readArtifact(env.MODEL_REPORT_BASE_DIR);
  const source = {
    sha: run.head_sha,
    id: run.id,
    number: run.run_number,
    attempt: run.run_attempt,
    conclusion: run.conclusion,
  };
  const baselineRun = { id: Number(env.MODEL_REPORT_BASE_RUN), sha: env.MODEL_REPORT_BASE_SHA };
  const runUrl = (id) =>
    `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${id}`;
  const body = renderComment({
    current,
    baseline,
    source,
    baselineRun,
    exactBase: env.MODEL_REPORT_EXACT_BASE === "true",
    runUrl,
  });
  const params = { ...context.repo, issue_number: pullNumber };
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...params,
    per_page: 100,
  });
  const existing = comments.find(
    (comment) => comment.user?.login === "github-actions[bot]" && comment.body?.startsWith(MARKER),
  );
  const previous = existing?.body.match(
    /<!-- t3-model-request-run ([a-f0-9]{40}) (\d+) (\d+) (result|missing) -->/,
  );
  if (
    previous &&
    previous[1] === source.sha &&
    ((!current && previous[4] === "result") ||
      Number(previous[2]) > source.number ||
      (Number(previous[2]) === source.number && Number(previous[3]) > source.attempt))
  ) {
    return core.info("The comment already has a newer or more complete measurement for this head.");
  }

  const { data: pull } = await github.rest.pulls.get({ ...context.repo, pull_number: pullNumber });
  if (!matchesPull(pull, run, context.payload.repository.id)) {
    return core.info("The pull request no longer matches this CI run.");
  }
  if (existing) {
    await github.rest.issues.updateComment({ ...context.repo, comment_id: existing.id, body });
  } else {
    await github.rest.issues.createComment({ ...params, body });
  }
}

module.exports = { publish, readArtifact, renderComment, resolve, validateResult };
