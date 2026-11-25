# Performance regression checks

## Wire and payload budgets

```bash
vp run test:perf:v2-wire
```

Exercises real V2 projections and client reducers. Payload budgets are enforced in
[`transferBudgetV2.integration.test.ts`](../../apps/server/integration/transferBudgetV2.integration.test.ts)
(whose opt-in objects are typed `Required` against contracts so new client opt-ins must be tested)
and reported in CI via `TransferBudgetReport.integration.ts`. Run this whenever changing projection
schemas, history paging, shell synchronization, or thread state.

Core wire invariants:

- **Bounded windows.** Cold opens, history pages, and resume catch-ups enforce byte and row bounds
  before decoding full payloads, and exclude finished runs and duplicate message tables outside the
  active window.
- **No raw tool bodies on thread snapshots.** Raw command output, dynamic-tool result bodies, and
  inline file-change bodies are omitted at the wire boundary (diffs and explicit transcript exports
  fetch full data on demand).
- **Live command output bypasses orchestration events.** Adapters stream raw command output to
  [`CommandOutputHub`](../../apps/server/src/orchestration-v2/CommandOutputHub.ts) ahead of event
  ingestion, and clients subscribe only while a command row is expanded. Never route output deltas
  through `turn_item.updated`—a busy command would flood the event store and stall every thread.
- **Incremental shell sync.** Initial shells send active navigation rows only (omitting archived
  rows, idle subagents, and older settled threads), and resumes send deltas rather than full
  snapshots.

## Model request budgets

`vp run report:model-requests` starts the real T3 server with fresh state and drives
`thread start --wait` followed by `thread send --wait`. The pinned Codex, Claude, and
Antigravity runtimes send requests to synthetic HTTP endpoints on loopback. The server and
direct runs use fresh provider profiles, dummy keys, and blocked proxy targets. CI runs with
only the loopback network interface.

```sh
vp run report:model-requests --codex /path/to/codex --claude /path/to/claude --antigravity /path/to/agy \
  --budget .t3/model-request-result.json --comparison .t3/model-request-comparison.json
```

The required runtimes are Codex 0.169.0, Claude Code 2.1.330 (native binary from
`@anthropic-ai/claude-agent-sdk@0.3.330`), and agy 1.5.16. Omit `--comparison` in CI.
The comparison pairs each T3 session with a direct first turn from the same physical project
directory, binary, model, and prompt. Claude uses default permission mode and medium effort.
Antigravity uses its default permission mode and Gemini 3.1 Pro at low effort. Both Codex paths
use workspace-write. T3 uses on-request approval, while `codex exec` uses never. The fixture
uses a plain session because T3 thread launch has no portable per-agent instruction override.

The total counts the exact HTTP body bytes seen during the turn, including auxiliary model
requests. The breakdown reserializes JSON fields of the largest request carrying the current
prompt for the configured model, so its components need not add up to the full size. Use
`--raw <new-local-file>` for opt-in request bodies. Only the numeric budget JSON is uploaded
by CI. A separate workflow on the default branch validates the artifact and reports the delta
from a successful `main` measurement.

## Server process metrics

[`scripts/server-metrics.ts`](../../scripts/server-metrics.ts) benchmarks server CPU, wakeups, RSS,
heap, and first-request latency against a fake Anthropic API and the real `claude` CLI.
Run `vp run report:server payload` to inspect one turn's model-facing HTTP body sizes
and tool definitions using the same fixture. This command uses an isolated profile
and reports byte counts and tool names, with no request text or credentials.

For process measurements:

- Always compare refs with `ab <checkoutA> <checkoutB>` on the same machine rather than comparing
  isolated runs.
- Use `scaling` to separate per-thread cost from fixed server overhead, and `--soak <minutes>` to
  spot rising heap slopes (leaks). A leak only shows in code the soak drives, so give a new
  subsystem with long-lived state a part in its workload.
- Steer server work by `working`: many worktree threads editing files at once with one client
  subscribed to all of them. Turns per minute that stay flat as threads are added mean the
  server, not the agents, is the bottleneck.
- Upper bounds no user hits daily, such as 20 clients reconnecting at once, run only with
  `--stress`; the default reconnect is a user's 3 devices holding 10 threads each.
- `--quick` shortens every window for a per-PR or nightly check; `compare` refuses to mix quick
  and full runs. `server-metrics --help` says which scenario to trust for what.
- Test macOS, Windows, and Linux with `--no-agent-scope`: Linux systemd agent scopes mask
  per-process polling paths that other platforms run.

## Persistence and background work invariants

- Event-store sequence cursors and startup recovery candidate selection must seek indexes rather
  than scan retained history or decode completed threads just to discover no work remains.
- Trace and provider logs must use asynchronous, serialized writes and rotation—synchronous appends
  stall the server event loop on slow disks (especially Windows).
- Background awareness and settlement work must coalesce per thread and ignore high-frequency
  transcript/tool-output deltas.

## Mobile looping animations

`apps/mobile/package.json` enables Reanimated's `DISABLE_COMMIT_PAUSING_MECHANISM` for iOS keyboard
avoidance without React Native's `preventShadowTreeCommitExhaustion`. Continuous Reanimated frames
(`withRepeat`) commit to the shadow tree every frame and can starve React's JS commits, freezing the
screen (or aborting in dev with `ShadowTree.cpp: assertion failed`). Use React Native's `Animated`
with `useNativeDriver: true` for looping animations that run beside heavy content (see
[`thread-work-log.tsx`](../../apps/mobile/src/features/threads/thread-work-log.tsx)).
