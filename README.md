# jevprune

Keeps the lines of a command's output that matter for the task you are working on. Every kept line is printed exactly as the command wrote it. The full output is saved on disk and any dropped range can be printed back.

Built for coding agents that run `npm test`, `cargo build`, `pytest` or `docker compose up` and push thousands of lines into their context. Line relevance is decided per line by [Jev](https://typesafe.ai), TypeSafe's model, with a fixed set of lines kept before Jev sees anything: the last 40 lines, every error signature, and the lines around it.

## Install

```sh
npm install -g jevprune
export TYPESAFE_API_KEY=...   # early-access key from typesafe.ai
```

Claude Code plugin (wraps every Bash call automatically):

```sh
claude plugin marketplace add ibrahemid/jevprune
claude plugin install jevprune@jevprune
```

The plugin calls the globally installed `jevprune` binary. Without the binary the hook does nothing and commands run as before. Without a key, commands are still wrapped and pruning falls back to head and tail.

## Use

```sh
jevprune run --task "fix the failing auth test" -- npm test
npm test 2>&1 | jevprune select --task "fix the failing auth test"
jevprune show <run-id> --lines 120-531
jevprune gain
```

`run` executes the command with the given arguments (no shell), captures stdout and stderr in arrival order, prints the kept lines and exits with the command's exit code. `select` prunes a file or stdin. `show` prints an exact range of a saved run. `gain` sums what pruning saved so far on this machine.

The task comes from `--task`, else `JEVPRUNE_TASK`, else (inside the Claude Code plugin) the first prompt of the session, else the command itself.

## Demo

![jevprune demo](docs/demo.gif)

The fixture `test/fixtures/npm-test.log` is a 2,979-line vitest run with one failing test in `src/auth/login.test.ts` and a handful of slow tests. Same log, two tasks.

```sh
jevprune select --task "fix the failing auth test" --command "npm test" --file test/fixtures/npm-test.log
```

```
[jevprune: 53 lines dropped, run mu6ln7nv-3cb9, lines 1-53]
stderr | src/auth/oauth.test.ts > oauth > paginates the sort order
[jevprune: 456 lines dropped, run mu6ln7nv-3cb9, lines 55-510]
 ✓ src/auth/login.test.ts > login > merges a stale session 3ms
 ✓ src/auth/login.test.ts > login > clears unicode input 3ms
 ✓ src/auth/login.test.ts > login > ignores the previous state 2ms
 × src/auth/login.test.ts > login > rejects an expired session token 14ms
 ✓ src/auth/login.test.ts > login > updates the locale 3ms
 ✓ src/auth/login.test.ts > login > keeps the default value 3ms
 ✓ src/auth/login.test.ts > login > computes a network failure 18ms
[jevprune: 724 lines dropped, run mu6ln7nv-3cb9, lines 518-1241]
stderr | src/notifications/push.test.ts > push > paginates duplicate entries
Warning: An update to Form inside a test was not wrapped in act(...).
[jevprune: 1696 lines dropped, run mu6ln7nv-3cb9, lines 1244-2939]
 ✓ src/components/toast.test.ts > toast > restores a stale session 5ms
 ✓ src/components/toast.test.ts > toast > ignores a negative quantity 9ms
 ✓ src/components/toast.test.ts > toast > emits an empty input 9ms
 ✓ src/components/toast.test.ts > toast > emits an unknown id 12ms
 ✓ src/components/toast.test.ts > toast > formats the previous state 1ms
 ✓ src/components/toast.test.ts > toast > filters the cached result 4ms
 ✓ src/components/toast.test.ts > toast > ignores a network failure 18ms
 ✓ src/components/toast.test.ts > toast > clears a large payload 18ms
 ✓ src/components/toast.test.ts > toast > merges a partial update 0ms
 ✓ src/components/toast.test.ts > toast > clears leading whitespace 7ms
 ✓ src/components/toast.test.ts > toast > filters a stale session 25ms
 ✓ src/components/toast.test.ts > toast > returns a negative quantity 12ms

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯

 FAIL  src/auth/login.test.ts > login > rejects an expired session token
AssertionError: expected 200 to be 401 // Object.is equality

- Expected
+ Received

- 401
+ 200

 ❯ src/auth/login.test.ts:88:29
     86|     const response = await login({ token: expiredToken });
     87| 
     88|     expect(response.status).toBe(401);
       |                             ^
     89|     expect(response.body.error).toBe("session expired");
     90|   });

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed | 94 passed (95)
      Tests  1 failed | 2914 passed (2915)
   Start at  09:12:04
   Duration  41.20s (transform 4.11s, setup 1.62s, collect 12.30s, tests 33.94s, environment 9.81s)

jevprune: 2,979 → 54 lines, full output ~/.jevprune/runs/mu6ln7nv-3cb9.log
```

```sh
jevprune select --task "why is the build slow" --command "npm test" --file test/fixtures/npm-test.log
```

Lines 53 to 78 of the 347 it printed, and the footer:

```
 ✓ src/billing/refunds.test.ts > refunds > rejects a negative quantity 12ms
 ✓ src/billing/refunds.test.ts > refunds > clears a stale session 1170ms
[jevprune: 4 lines dropped, run mu6ln5j9-4968, lines 844-847]
 ✓ src/billing/refunds.test.ts > refunds > keeps an empty input 1282ms
 ✓ src/billing/refunds.test.ts > refunds > updates a trailing slash 1083ms
 ✓ src/billing/refunds.test.ts > refunds > ignores an empty input 2ms
 ✓ src/billing/refunds.test.ts > refunds > sorts an expired token 7ms
 ✓ src/billing/refunds.test.ts > refunds > sorts a missing field 2216ms
 ✓ src/billing/refunds.test.ts > refunds > renders a network failure 25ms
 ✓ src/billing/refunds.test.ts > refunds > parses an expired token 1904ms
 ✓ src/billing/refunds.test.ts > refunds > merges an empty input 7ms
 ✓ src/billing/refunds.test.ts > refunds > parses the sort order 1013ms
[jevprune: 9 lines dropped, run mu6ln5j9-4968, lines 857-865]
 ✓ src/hooks/use-form.test.ts > use-form > keeps a network failure 1610ms
 ✓ src/hooks/use-form.test.ts > use-form > paginates a partial update 2095ms
 ✓ src/hooks/use-form.test.ts > use-form > keeps the cached result 2512ms
 ✓ src/hooks/use-form.test.ts > use-form > parses the locale 466ms
 ✓ src/hooks/use-form.test.ts > use-form > updates a stale session 2ms
 ✓ src/hooks/use-form.test.ts > use-form > merges a negative quantity 1ms
 ✓ src/hooks/use-form.test.ts > use-form > restores an empty input 2073ms
 ✓ src/hooks/use-form.test.ts > use-form > filters a missing field 2203ms
[jevprune: 4 lines dropped, run mu6ln5j9-4968, lines 874-877]
 ✓ src/hooks/use-form.test.ts > use-form > paginates the previous state 483ms
[jevprune: 8 lines dropped, run mu6ln5j9-4968, lines 879-886]
 ✓ src/hooks/use-form.test.ts > use-form > validates a large payload 1372ms
[jevprune: 6 lines dropped, run mu6ln5j9-4968, lines 888-893]
```

```
jevprune: 2,979 → 347 lines, full output ~/.jevprune/runs/mu6ln5j9-4968.log
```

The first task keeps the failure block and the auth lines around it. The second keeps the timing lines instead. Neither view rewrote a line. A dropped section comes back exactly:

```sh
jevprune show mu6ln7nv-3cb9 --lines 55-57
```

```
[deprecation] `fetchJson` is deprecated, use `http.get` instead

 ✓ src/api/errors.test.ts > errors > merges the sort order 3ms
```

## What is kept

1. 60 lines or fewer: everything, untouched, no request made.
2. The command failed (non-zero exit or signal): everything, untouched. Failure output is evidence and is never pruned.
3. Otherwise, before Jev: the last 40 lines, every line matching an error signature (`FAIL`, `error:`, `AssertionError`, `Traceback`, stack frames, `exited with code`, and similar), and the 3 lines on each side of it. Repeated identical signature lines count once.
4. The remaining lines go to Jev in windows, one yes/no question per line: is this line needed for the task? Lines scoring at or above the threshold (default 0.3) are kept.
5. Dropped runs shorter than 3 lines are kept. Longer ones collapse into one marker:

```
[jevprune: 412 lines dropped, run m1xk2p7a-3f9c, lines 120-531]
```

The last line of the output is the footer:

```
jevprune: 3,104 → 88 lines, exit 0, full output ~/.jevprune/runs/m1xk2p7a-3f9c.log
```

## The exact-text guarantee

jevprune never rewrites, summarizes or reorders a line. Every line it prints is byte-identical to a line the command wrote, in the original order. The only text it adds is the collapse marker and the footer. The full output is on disk before any decision is made, and `jevprune show <id> --lines A-B` prints any range back exactly.

This is not lossless. A dropped line may have mattered. Retained text is exact; dropped text is recoverable; a wrong drop is possible. When a line you expect is missing, run `show` on the marker's range before concluding it is absent.

## Fallback

No key, a rejected key, a rate limit, an outage, a timeout or a malformed answer never fails the command. jevprune keeps the deterministic set plus the first 40 and last 40 lines and says so in the footer:

```
jevprune: fallback (no Jev: timeout), 3,104 → 83 lines, exit 0, full output ~/.jevprune/runs/<id>.log
```

## Claude Code plugin

A `PreToolUse` hook on `Bash` rewrites the command to `jevprune run --hook --transcript <path> -- bash -c '<command>'`. `bash -c` keeps pipelines, redirects and quoting as the agent wrote them; jevprune only owns capture and selection.

The hook leaves a command alone when it is already wrapped, runs in the background, ends with `&`, changes shell state (`cd`, `export`, `source`, `.`, `unset`, `alias`, `set`, `eval`, `exec`, `pushd`, `popd`), starts an interactive program (`vim`, `less`, `ssh`, `sudo`, `top`, `tmux`, `claude`, and similar), starts a REPL or shell with no arguments (`python`, `node`, `bash`, `psql`, `gh`), runs `docker exec` or `docker run` with a terminal flag, follows a file with `tail -f`, or starts with an allowlisted prefix (`cd`, `ls`, `pwd`, `echo`, `git status`, `git add`, `git commit`, `git log`, `git diff --stat`, `which`, `mkdir`, `touch`, `true`, `test`, `[`).

Set `"autoWrap": false` in `~/.jevprune/config.json` to turn the rewrite off. The bundled skill then tells the agent to call `jevprune run` itself for long commands.

## Configuration

`~/.jevprune/config.json`, all keys optional:

| key | default | meaning |
|---|---|---|
| `threshold` | `0.3` | minimum Jev score to keep a line |
| `fastPathLines` | `60` | outputs up to this many lines pass through untouched |
| `tailLines` | `40` | lines always kept at the end |
| `headLines` | `40` | lines kept at the start in fallback |
| `contextLines` | `3` | lines kept around each error signature |
| `minCollapseLines` | `3` | shorter dropped runs are kept instead of collapsed |
| `windowTokens` | `25000` | estimated token budget per Jev request |
| `windowTimeoutMs` | `10000` | per-window timeout before fallback |
| `concurrency` | `4` | Jev requests in flight |
| `maxPruneBytes` | `16777216` | larger outputs use fallback on the head and tail |
| `retention.maxRuns` | `200` | saved runs kept |
| `retention.maxBytes` | `268435456` | total bytes of saved runs kept |
| `autoWrap` | `true` | plugin rewrites Bash commands |
| `allowlist` | see above | command prefixes the plugin never wraps |

Environment: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `JEVPRUNE_TASK`, `JEVPRUNE_HOME` (default `~/.jevprune`).

The defaults were set on real outputs from one machine (a vitest run, a Next.js build, a docker compose startup, a pytest run, a cargo build). They are a starting point.

## Library

```ts
import { pruneOutput } from "jevprune";

const result = await pruneOutput({
  text: output,
  task: "fix the failing auth test",
  command: "npm test",
  exitCode: 0,
});
result.kept;      // exact retained text with collapse markers
result.dropped;   // [{ from, to, count }]
result.runId;     // for `jevprune show`
result.mode;      // "fast-path" | "passthrough" | "jev" | "fallback"
```

`pruneStream` takes a readable stream instead of `text`. Pass `client` to supply your own Jev client (a `FakeJevClient` is exported for tests) and `save: false` to skip the run store.

## Limits

- Not lossless. See the guarantee above.
- Questions cost tokens too. A 3,000-line output is roughly 5 to 10 Jev requests depending on line length. Output tokens are free; input is billed by TypeSafe.
- Needs an early-access TypeSafe key. Without one, every pruned run is the head-and-tail fallback.
- `run` takes an executable and arguments, no shell string. Use `bash -c '...'` for pipelines, which is what the plugin does.
- Outputs over 16 MiB are pruned by head and tail only.
- Everything jevprune saves stays under `~/.jevprune`. The task text is stored there with each run and nowhere else.

## Neighbors

- [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) replaces Claude Code's compaction summary with Jev decisions over the whole conversation. jevprune prunes one command's output at the moment it is produced, before it enters context. They compose. An open pull request there trims Bash output in 20-line chunks behind an early-access function-hook flag; jevprune scores single lines against the task, keeps error signatures with context before Jev is asked, runs on the documented `PreToolUse` hook, and works as a CLI and library outside Claude Code.
- [RTK](https://github.com/rtk-ai/rtk) filters output with rules written per tool. jevprune has no per-tool rules; the task decides.
- [Squeez](https://github.com/KRLabsOrg/squeez) selects task-relevant lines with a local 2B model, in Python. jevprune does the same job through the TypeSafe API, with exact recall of dropped ranges and a run store.

## License

MIT
