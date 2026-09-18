# jevprune

jevprune filters long command output for coding agents using a task description. Retained lines keep their original text and order.

## Install

Requires Node.js 22 or later. Jev selection also requires an early-access TypeSafe API key. Without one, jevprune keeps the first 40 lines, the last 40 lines, and every error line with the 3 lines around it. Keys come from the waitlist at [typesafe.ai](https://typesafe.ai).

```sh
npm install -g jevprune
export TYPESAFE_API_KEY=...
```

Line relevance is decided per line by [Jev](https://typesafe.ai), TypeSafe's model. For Jev-selected runs, jevprune sends the task, command, and candidate output lines to the TypeSafe API. Blank lines and lines kept by deterministic rules are not sent.

## Quick start

```sh
jevprune run --task "fix the failing auth test" -- npm test
```

`run` executes the command with the given arguments (no shell), captures stdout and stderr in arrival order, prints the kept lines and exits with the command's exit code. For a pipeline or a redirect, use `-- bash -c '...'`.

```sh
jevprune select --task "find the slow build step" --file build.log
```

`select` prunes a local file or stdin and exits 0 when it processes the input successfully. It cannot read or preserve the producer's exit status, so use `run` when exit status matters.

A pruned run ends with a footer that carries its run ID, and every collapse marker carries a line range. Print a range back:

```sh
jevprune show <run-id> --lines 120-531
```

```sh
jevprune gain
```

`gain` totals locally recorded input and output lines and estimates the removed output tokens.

The task comes from `--task`, else `JEVPRUNE_TASK`, else, when the plugin rewrite hook supplies a transcript, the first prompt of the session, else the command itself.

## Demo

![jevprune demo](docs/demo.gif)

The demo filters a saved test log, then retrieves omitted lines from its saved run. Run IDs are generated locally. The first task is a `select` run over a saved failure log; `run` passes a failed command's output through in full.

Run the demo from a source checkout:

```sh
git clone https://github.com/ibrahemid/jevprune.git
cd jevprune
```

```sh
jevprune select --task "fix the failing auth test" --command "npm test" --file test/fixtures/npm-test.log
jevprune select --task "why is the build slow" --command "npm test" --file test/fixtures/npm-test.log
```

```
jevprune: 2,979 → 54 lines, full output ~/.jevprune/runs/mu6ln7nv-3cb9.log
jevprune: 2,979 → 347 lines, full output ~/.jevprune/runs/mu6ln5j9-4968.log
```

In these recorded runs, the auth task kept 54 of 2,979 lines and the timing task kept 347. Use the run ID and line range printed by a local run to retrieve omitted output while its log is retained.

[Full demo output](https://github.com/ibrahemid/jevprune/blob/main/docs/demo-output.md).

## How selection and recovery work

1. 60 lines or fewer: everything, untouched, no request made.
2. `run` passes through all output when its command exits non-zero or receives a signal. `select` does not know the producer's exit status, so it can prune a failure log.
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

jevprune preserves every retained command line byte-for-byte and in its original order. It inserts only collapse markers and a footer.

A dropped line may have mattered. When a line you expect is missing, run `show` on the marker's range before concluding it is absent. When the footer includes `full output <path>`, `jevprune show <id> --lines A-B` prints that saved range exactly. If the footer says `full output was not saved`, dropped ranges cannot be recovered. Retention deletes the oldest saved runs once either limit in the configuration table is reached, so an older run can become unavailable.

A missing or rejected key, a rate limit, an outage, a timeout or a malformed answer does not fail the command. jevprune keeps the deterministic set plus the first 40 and last 40 lines and says so in the footer:

```
jevprune: fallback (Jev unavailable: timeout), 3,104 → 83 lines, exit 0, full output ~/.jevprune/runs/<id>.log
```

Input over the size limit takes the same selection with no Jev request, and its footer names the limit rather than an unavailable Jev:

```
jevprune: fallback (output over 16777216 bytes), 51,234 → 83 lines, exit 0, full output ~/.jevprune/runs/<id>.log
```

## Claude Code plugin

```sh
claude plugin marketplace add ibrahemid/jevprune
claude plugin install jevprune@jevprune
```

The plugin bundles a skill and an optional Bash rewrite hook. Both call the globally installed `jevprune` binary. Without the binary, commands run as before.

The skill is the default path. It tells the agent to call `jevprune run --task "<task>" -- <command>` itself, so the user sees and approves the exact command that runs and nothing is rewritten after approval. It is still a different command from a bare `npm test`: a rule like `Bash(npm test:*)` does not match it, so the wrapped run needs its own approval. `Bash(jevprune run:*)` approves any command run through the wrapper.

The rewrite hook is off by default. Set `"autoWrap": true` in `~/.jevprune/config.json` to turn it on. A `PreToolUse` hook then rewrites the command to `jevprune run --hook --transcript <path> -- bash -c '<command>'`. `bash -c` keeps pipelines, redirects and quoting as the agent wrote them; jevprune only owns capture and selection. Permission rules are matched against the rewritten command, so rules such as `Bash(npm test:*)` stop matching: an interactive session prompts for each wrapped command, and a headless run can be denied.

The hook leaves a command alone when it is already wrapped, runs in the background, ends with `&`, changes shell state (`cd`, `export`, `source`, `.`, `unset`, `alias`, `set`, `eval`, `exec`, `pushd`, `popd`), starts an interactive program (`vim`, `less`, `ssh`, `sudo`, `top`, `tmux`, `claude`, and similar), starts a REPL or shell with no arguments (`python`, `node`, `bash`, `psql`, `gh`), runs `docker exec` or `docker run` with a terminal flag, follows a file with `tail -f`, or starts with an allowlisted prefix (`cd`, `ls`, `pwd`, `echo`, `git status`, `git add`, `git commit`, `git log`, `git diff --stat`, `which`, `mkdir`, `touch`, `true`, `test`, `[`).

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
| `maxPruneBytes` | `16777216` | bytes (16 MiB); larger input is pruned by head and tail, with no Jev request |
| `retention.maxRuns` | `200` | maximum saved runs before the oldest are deleted |
| `retention.maxBytes` | `268435456` | maximum saved-run bytes (256 MiB) before the oldest are deleted |
| `autoWrap` | `false` | when true, the plugin hook rewrites Bash commands |
| `allowlist` | see above | command prefixes the plugin never wraps |

Either retention limit can delete a run that a marker still refers to.

Environment: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `JEVPRUNE_TASK`, `JEVPRUNE_HOME` (default `~/.jevprune`).

The defaults were set on real outputs from one machine (a vitest run, a Next.js build, a docker compose startup, a pytest run, a cargo build). They are a starting point.

## Library

A global CLI install does not make the import available to a project, so install it there:

```sh
npm install jevprune
```

```ts
import { readFile } from "node:fs/promises";
import { pruneOutput } from "jevprune";

const output = await readFile("build.log", "utf8");

const result = await pruneOutput({
  text: output,
  task: "fix the failing auth test",
  command: "npm test",
  exitCode: 0,
});

result.kept;           // exact retained text with collapse markers
result.dropped;        // [{ from, to, count }]
result.runId;          // selection identifier
result.logPath;        // defined only when a recoverable run log was saved
result.footer;         // status text, separate from kept
result.mode;           // "fast-path" | "passthrough" | "jev" | "fallback"
result.linesIn;        // lines read
result.linesOut;       // lines in kept
result.fallbackReason; // fallback mode only: { kind: "unavailable", detail } or { kind: "size-limit", maxBytes }
```

| input | effect |
|---|---|
| `text` | the output to prune |
| `task` | the task the kept lines have to serve |
| `command` | supplies selection context |
| `exitCode` | a non-zero code passes the output through, unless the input is over `maxPruneBytes`; omitted or `null` means unknown and can be pruned |
| `client` | a supplied Jev client; `null` disables API selection, so eligible output uses the fallback |
| `config` | overrides the loaded configuration values |
| `env` | controls configuration and the default client |
| `save` | `false` disables the run store |

The four modes: `fast-path` for output within `fastPathLines`, `passthrough` for a failed command or non-UTF-8 output, `jev` for an API-selected run, `fallback` when Jev was unavailable or the input was over `maxPruneBytes`. `fast-path` and `save: false` return a `runId` with no `logPath`, and `jevprune show` cannot read those runs.

`pruneStream` has the same contract with `stream` replacing `text`. It holds only the head and the tail in memory, and with the run store enabled it streams the whole input there, so a stream over `maxPruneBytes` is pruned by head and tail and `show` still prints any dropped range. `FakeJevClient` is exported for tests.

## Limits and data handling

- Saved runs and metadata are stored under `~/.jevprune`. The data sent to the TypeSafe API is listed under Install.
- `select` exits 0 when it processes its input. It cannot report the exit status of the command that produced that input.
- Needs an early-access TypeSafe key. Without one, every pruned run is the head-and-tail fallback.
- Selection sends several requests for a long output and spends input tokens on the TypeSafe account that issued the key.
- `run` takes an executable and arguments, no shell string. Use `bash -c '...'` for pipelines, which is what the rewrite hook does.
- Input over 16 MiB is pruned by head and tail, with no Jev request. `run` still prints a failed command's output from its saved run log; when that log could not be saved, the footer says `full output was not saved` and the printed output is incomplete.
- Output that is not valid UTF-8 passes through untouched.

## Alternatives

- [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) selects conversation content during compaction. jevprune selects lines from each command as it finishes, and also works as a CLI or library. The tools can be used together.
- [RTK](https://github.com/rtk-ai/rtk) filters output with rules written per tool. jevprune has no per-tool rules; the task decides.
- [Squeez](https://github.com/KRLabsOrg/squeez) selects task-relevant lines with a 2B model, in Python, running locally or on a server. jevprune selects through the TypeSafe API and prints dropped ranges back from its run store.

## License

MIT
