#!/usr/bin/env node
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import {
  ANSWER,
  FIRST_PROMPT,
  NEXT_PROMPT,
  PROVIDERS,
  measureTurn,
  startModelEndpoint,
  type Provider,
} from "./model-request-endpoint.ts";
import { run } from "./scenarios/shell.ts";
import { MetricsError, startServer } from "./server-metrics.ts";
import ceilings from "./model-request-ceilings.json" with { type: "json" };

const CONFIG = {
  codex: {
    driver: "codex",
    version: "0.169.0",
    selection: "gpt-5.5",
    model: "gpt-5.5",
    runtimeMode: "auto-accept-edits",
    modelOptions: [],
  },
  claude: {
    driver: "claudeAgent",
    version: "2.1.330",
    selection: "claude-sonnet-5-5",
    model: "claude-sonnet-5-5",
    runtimeMode: "approval-required",
    modelOptions: ["--option", "effort=medium"],
  },
  antigravity: {
    driver: "antigravity",
    version: "1.5.16",
    selection: "gemini-3.1-pro",
    model: "gemini-3.1-pro-preview",
    runtimeMode: "approval-required",
    modelOptions: ["--option", "thought_level=low"],
  },
} as const;

const CLI_ARGS: Record<Provider, readonly string[]> = {
  codex: ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "--json", FIRST_PROMPT],
  claude: [
    "--print",
    "--output-format",
    "json",
    "--permission-mode",
    "default",
    "--model",
    CONFIG.claude.model,
    "--effort",
    "medium",
    FIRST_PROMPT,
  ],
  antigravity: [
    "--output-format",
    "json",
    "--model",
    CONFIG.antigravity.selection,
    "--effort",
    "low",
    `--print=${FIRST_PROMPT}`,
  ],
};

const DUMMY_KEY = "fixture-key";
const encodeJson = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));
const decodeProvider = Schema.decodeUnknownEffect(Schema.Literals(PROVIDERS));

const runResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      threadId: Schema.String,
      status: Schema.String,
      reply: Schema.NullOr(Schema.String),
    }),
  ),
);

const assertT3Reply = Effect.fn("modelRequest.assertT3Reply")(function* (
  result: Effect.Success<ReturnType<typeof run>>,
) {
  if (result.exitCode !== 0) {
    return yield* new MetricsError({
      message: `T3 turn failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    });
  }
  const outcome = yield* runResult(result.stdout);
  if (outcome.status !== "completed" || outcome.reply?.trim() !== ANSWER) {
    return yield* new MetricsError({ message: "T3 did not complete with the synthetic reply" });
  }
  return outcome.threadId;
});

const prepareEnvironment = Effect.fn("modelRequest.prepareEnvironment")(function* (
  home: string,
  origin: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostEnv = yield* HostProcess.Environment;
  const codexHome = path.join(home, ".codex");
  const geminiSettings = path.join(home, ".gemini", "antigravity-cli");
  yield* fs.makeDirectory(codexHome, { recursive: true });
  yield* fs.makeDirectory(geminiSettings, { recursive: true });
  yield* fs.writeFileString(
    path.join(codexHome, "config.toml"),
    [
      `model = "${CONFIG.codex.model}"`,
      'model_provider = "fixture"',
      'web_search = "disabled"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      "check_for_update_on_startup = false",
      "[features]",
      "apps = false",
      "plugins = false",
      "[model_providers.fixture]",
      'name = "Synthetic model endpoint"',
      `base_url = "${origin}/v1"`,
      'wire_api = "responses"',
      "requires_openai_auth = false",
    ].join("\n") + "\n",
  );
  yield* fs.writeFileString(
    path.join(geminiSettings, "settings.json"),
    yield* encodeJson({ modelProvider: "gemini", autoUpdate: false }),
  );
  return {
    PATH: hostEnv.PATH ?? "/usr/bin:/bin",
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    NO_PROXY: "127.0.0.1,localhost",
    HTTP_PROXY: "http://127.0.0.1:1",
    HTTPS_PROXY: "http://127.0.0.1:1",
    ALL_PROXY: "http://127.0.0.1:1",
    NODE_USE_ENV_PROXY: "1",
    ANTHROPIC_API_KEY: DUMMY_KEY,
    ANTHROPIC_BASE_URL: origin,
    DISABLE_NONESSENTIAL_MODEL_CALLS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    AGY_CLI_DISABLE_AUTO_UPDATE: "1",
    GOOGLE_GEMINI_BASE_URL: origin,
  };
});

const capture = Effect.fn("modelRequest.capture")(function* (
  provider: Provider,
  binaryPath: string,
  project: string,
  mode: "t3" | "cli",
  includeRaw: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const checkout = path.resolve(import.meta.dirname, "..");
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-model-home-" });
  const endpoint = yield* Effect.acquireRelease(
    Effect.promise(() => startModelEndpoint(provider)),
    (endpoint) => Effect.promise(() => endpoint.close()),
  );
  const env = yield* prepareEnvironment(home, `http://127.0.0.1:${endpoint.port}`);
  const { driver, selection, model, modelOptions, runtimeMode } = CONFIG[provider];
  const packageConfig =
    provider === "codex"
      ? { homePath: env.CODEX_HOME }
      : provider === "claude"
        ? { homePath: env.CLAUDE_CONFIG_DIR }
        : { authMethod: "gemini-api-key", apiKey: DUMMY_KEY };
  const snapshot = (start: number, prompt: string, followUp: boolean) => {
    if (endpoint.unexpected.size > 0) {
      throw new Error(`Unexpected model endpoint routes: ${[...endpoint.unexpected].join(", ")}`);
    }
    const requests = endpoint.requests.slice(start);
    return {
      ...measureTurn(requests, model, prompt, followUp),
      ...(includeRaw ? { rawRequests: requests.map(({ raw }) => raw) } : {}),
    };
  };

  if (mode === "cli") {
    const result = yield* run(binaryPath, CLI_ARGS[provider], {
      cwd: project,
      env: { ...env, ...(provider === "antigravity" ? { GEMINI_API_KEY: DUMMY_KEY } : {}) },
    }).pipe(Effect.timeout("45 seconds"));
    if (!result.stdout.includes(ANSWER)) {
      return yield* new MetricsError({
        message: `${provider} CLI did not return the synthetic reply`,
      });
    }
    return [snapshot(0, FIRST_PROMPT, false)];
  }

  const server = yield* startServer(
    {
      home,
      apiPort: endpoint.port,
      requests: [],
      noAgentScope: true,
      serverDir: path.join(checkout, "apps/server"),
      checkout,
    },
    "model-request",
    {
      project,
      isolatedCredentials: true,
      env,
      settings: {
        defaultRuntimeMode: runtimeMode,
        providerInstances: {
          [driver]: { driver, enabled: true, config: { binaryPath, ...packageConfig } },
        },
      },
    },
  ).pipe(Effect.timeout("45 seconds"));
  if (endpoint.requests.length > 0) {
    return yield* new MetricsError({
      message: `${provider} made a model call before the first turn`,
    });
  }
  const threadId = yield* server
    .cli([
      "thread",
      "start",
      "--wait",
      "--json",
      "--provider",
      driver,
      "--model",
      selection,
      ...modelOptions,
      project,
      FIRST_PROMPT,
    ])
    .pipe(Effect.timeout("60 seconds"), Effect.flatMap(assertT3Reply));
  const first = snapshot(0, FIRST_PROMPT, false);
  const start = endpoint.requests.length;
  yield* server
    .cli(["thread", "send", "--wait", "--json", threadId, NEXT_PROMPT])
    .pipe(Effect.timeout("60 seconds"), Effect.flatMap(assertT3Reply));
  return [first, snapshot(start, NEXT_PROMPT, true)];
}, Effect.scoped);

type Capture = Effect.Success<ReturnType<typeof capture>>;
type Comparison = {
  provider: Provider;
  model: string;
  runtime: string;
  runtimeMode: string;
  t3: Capture;
  cli: Capture | undefined;
};

function budgetMetrics(turn: Capture[number]) {
  const {
    bytes,
    calls,
    primaryBytes,
    inputBytes,
    instructionBytes,
    toolBytes,
    auxiliaryBytes,
    auxiliaryCalls,
  } = turn;
  return {
    bytes,
    calls,
    primaryBytes,
    inputBytes,
    instructionBytes,
    toolBytes,
    auxiliaryBytes,
    auxiliaryCalls,
  };
}

const writeBudget = Effect.fn("modelRequest.writeBudget")(function* (
  file: string,
  comparisons: readonly Comparison[],
) {
  const fs = yield* FileSystem.FileSystem;
  const results = [];
  const failures: string[] = [];
  for (const { provider, t3 } of comparisons) {
    const [first, next] = t3;
    if (!first || !next)
      return yield* new MetricsError({ message: `Missing T3 turns for ${provider}` });
    const observed = { first: budgetMetrics(first), next: budgetMetrics(next) };
    const limits = ceilings[provider];
    for (const phase of ["first", "next"] as const) {
      for (const [key, ceiling] of Object.entries(limits[phase])) {
        const value = observed[phase][key as keyof typeof limits.first];
        if (value > ceiling)
          failures.push(`${provider} ${phase} ${key} ${value} exceeds ${ceiling}`);
      }
    }
    results.push({ provider, observed, ceilings: limits });
  }
  const result = yield* encodeJson({ version: 1, results });
  yield* fs.writeFileString(file, result + "\n");
  if (failures.length > 0) return yield* new MetricsError({ message: failures.join("\n") });
});

const benchmark = Command.make(
  "model-request-benchmark",
  {
    codex: Flag.String("codex").pipe(
      Flag.withDescription(`Codex ${CONFIG.codex.version} executable.`),
      Flag.withDefault("codex"),
    ),
    claude: Flag.String("claude").pipe(
      Flag.withDescription(`Claude Code ${CONFIG.claude.version} executable.`),
      Flag.withDefault("claude"),
    ),
    antigravity: Flag.String("antigravity").pipe(
      Flag.withDescription(`Antigravity ${CONFIG.antigravity.version} executable.`),
      Flag.withDefault("agy"),
    ),
    provider: Flag.String("provider").pipe(
      Flag.withDescription("Measure only codex, claude, or antigravity."),
      Flag.optional,
    ),
    comparison: Flag.String("comparison").pipe(
      Flag.withDescription(
        "Run paired direct CLI first turns and write their numeric comparison here.",
      ),
      Flag.optional,
    ),
    budget: Flag.String("budget").pipe(
      Flag.withDescription("Write numeric T3 observations and fail if any ceiling is exceeded."),
      Flag.optional,
    ),
    raw: Flag.String("raw").pipe(
      Flag.withDescription("Keep raw synthetic bodies in a new private local file."),
      Flag.optional,
    ),
  },
  Effect.fn("modelRequest.benchmark")(function* (flags) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-model-root-" });
    const project = yield* fs.realPath(
      yield* fs.makeTempDirectoryScoped({ prefix: "t3-model-workspace-" }),
    );
    yield* fs.writeFileString(
      path.join(project, "checkout.test.ts"),
      "// Synthetic checkout test for the model request comparison.\n",
    );
    const versionEnv = yield* prepareEnvironment(home, "http://127.0.0.1:1");
    const selected = yield* decodeProvider(Option.getOrUndefined(flags.provider)).pipe(
      Effect.option,
    );
    if (Option.isSome(flags.provider) && Option.isNone(selected)) {
      return yield* new MetricsError({
        message: "Expected --provider codex, claude, or antigravity",
      });
    }
    if (Option.isSome(flags.budget) && Option.isSome(selected)) {
      return yield* new MetricsError({ message: "A budget artifact requires all three providers" });
    }
    const comparison = Option.isSome(flags.comparison) || Option.isSome(flags.raw);
    const includeRaw = Option.isSome(flags.raw);
    const results: Comparison[] = [];
    for (const provider of Option.match(selected, {
      onNone: () => PROVIDERS,
      onSome: (provider) => [provider],
    })) {
      const candidate = flags[provider].includes(path.sep)
        ? path.resolve(flags[provider])
        : flags[provider];
      const binaryPath = yield* resolveCommandPath(candidate, { env: versionEnv });
      if (!binaryPath)
        return yield* new MetricsError({
          message: `Cannot locate ${provider} executable: ${candidate}`,
        });
      const { stdout } = yield* run(binaryPath, ["--version"], {
        cwd: project,
        env: versionEnv,
      }).pipe(Effect.timeout("30 seconds"));
      const version = stdout.trim().match(/\b\d+\.\d+\.\d+\b/)?.[0];
      if (version !== CONFIG[provider].version) {
        return yield* new MetricsError({
          message: `Expected ${provider} ${CONFIG[provider].version}, got ${stdout.trim()}`,
        });
      }
      yield* Console.error(`Measuring ${provider} ${version} through the T3 server`);
      const t3 = yield* capture(provider, binaryPath, project, "t3", includeRaw);
      const cli = comparison
        ? yield* capture(provider, binaryPath, project, "cli", includeRaw)
        : undefined;
      const { model, runtimeMode } = CONFIG[provider];
      results.push({ provider, model, runtime: version, runtimeMode, t3, cli });
    }
    const metadata = {
      version: 1,
      platform: yield* HostProcess.Platform,
      arch: yield* HostProcess.Architecture,
      node: process.version,
      cwd: project,
      prompt: FIRST_PROMPT,
      followUp: NEXT_PROMPT,
    };
    if (Option.isSome(flags.raw)) {
      const raw = yield* encodeJson({ ...metadata, results });
      yield* fs.writeFileString(flags.raw.value, raw + "\n", {
        mode: 0o600,
        flag: "wx",
      });
    }
    const numericTurn = ({
      rawRequests: _rawRequests,
      ...turn
    }: (typeof results)[number]["t3"][number]) => turn;
    const numeric = {
      ...metadata,
      results: results.map(({ t3, cli, ...rest }) => ({
        ...rest,
        t3: t3.map(numericTurn),
        cli: cli?.map(numericTurn),
      })),
    };
    const formatted = (yield* encodeJson(numeric)) + "\n";
    if (Option.isSome(flags.comparison))
      yield* fs.writeFileString(flags.comparison.value, formatted);
    else if (Option.isNone(flags.budget)) yield* Console.log(formatted.trimEnd());
    if (Option.isSome(flags.budget)) yield* writeBudget(flags.budget.value, results);
  }, Effect.scoped),
);

if (import.meta.main) {
  Command.run(benchmark, { version: "1.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeHttpClient.layerUndici,
        NodeSocket.layerWebSocketConstructor,
      ),
    ),
    NodeRuntime.runMain,
  );
}
