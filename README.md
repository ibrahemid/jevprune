# jevprune

jevprune filters long command output for coding agents using a task description. Retained lines keep their original text and order.

## Install

Requires Node.js 22 or later.

CLI and library:

```sh
npm i -g jevprune
```

Claude Code plugin:

```sh
claude plugin marketplace add ibrahemid/jevprune
claude plugin install jevprune@jevprune
```

The plugin prunes each Bash result as it returns, before the model reads it. Its hooks module carries its own copy of the engine, so it works without the global install; the skill it bundles uses the `jevprune` CLI when one is there. The module loads only when function hooks are turned on, which is early access in Claude Code. Put the switch in your settings `env`:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

### The key

Jev selection needs an early-access TypeSafe API key. Keys come from the waitlist at [typesafe.ai](https://typesafe.ai).

Without one the CLI and the library fall back to the rules: the first 40 lines, the last 40 lines, and every error line with the 3 lines around it, with the reason in the footer. The plugin does not prune until a key is configured. It returns every result untouched and logs once per session:

```
jevprune: TYPESAFE_API_KEY not set, results pass through
```

The plugin looks for the key in three places, in order:

1. the `/plugin` config dialog, option "TypeSafe API key", stored in the Keychain
2. `TYPESAFE_API_KEY` in the environment
3. `TYPESAFE_API_KEY` in settings `env`

The CLI and the library read the environment variable.

For a Jev-selected run, jevprune sends the task, the command and the candidate output lines to the TypeSafe API. Blank lines and lines the rules already kept are not sent.

## What a pruned result looks like

Markers and footers come from `run`, `select` and `pruneOutput`, and from a result the plugin pruned. A result the plugin passed through is the original, with no marker and no footer.

A dropped run of 3 lines or more collapses into one marker:

```
[jevprune: 412 lines dropped, run m1xk2p7a-3f9c, lines 120-531]
```

The last line is the footer:

```
jevprune: 3,104 → 88 lines, exit 0, full output ~/.jevprune/runs/m1xk2p7a-3f9c.log
```

In Claude Code the run id also arrives as a toast:

```
jevprune: 3,104 → 88 lines, run m1xk2p7a-3f9c
```

A missing or rejected key, a rate limit, an outage, a timeout or a malformed answer does not fail the command. jevprune falls back to the rules and names the reason:

```
jevprune: fallback (Jev unavailable: timeout), 3,104 → 83 lines, exit 0, full output ~/.jevprune/runs/m1xk2p7a-3f9c.log
```

In the CLI and the library, input over `maxPruneBytes` takes the same rules with no Jev request, and the footer names the limit instead:

```
jevprune: fallback (output over 16777216 bytes), 51,234 → 83 lines, exit 0, full output ~/.jevprune/runs/m1xk2p7a-3f9c.log
```

When `run`, `select` or `pruneOutput` passes output through untouched, the footer names the reason:

```
jevprune: 2,979 lines passed through (output looks like a document)
jevprune: exit 0, 122 lines passed through (output looks like a credential, full output was not saved)
jevprune: exit 1, 122 lines passed through, full output ~/.jevprune/runs/m1xk2p7a-3f9c.log
```

When the run log could not be written, the footer carries the error code in place of the path:

```
jevprune: 3,104 → 88 lines, exit 0, full output was not saved (EACCES)
```

## Recovering dropped lines

A dropped line may have mattered. When a line you expect is missing, print the marker's range before concluding it is absent:

```sh
jevprune show m1xk2p7a-3f9c --lines 120-531
```

`show` prints the saved bytes for that range, from any shell. When the footer says the full output was not saved, there is nothing to print back.

![jevprune demo](docs/demo.gif)

The demo prunes one saved vitest log for two different tasks and reads a dropped range back. [Full demo output](https://github.com/ibrahemid/jevprune/blob/main/docs/demo-output.md).

## Commands

```sh
jevprune run --task "fix the failing auth test" -- npm test
```

`run` executes the command with the given arguments (no shell), captures stdout and stderr in arrival order, prints the kept lines and exits with the command's exit code. For a pipeline or a redirect, use `-- bash -c '...'`.

```sh
jevprune select --task "find the slow build step" --file build.log
```

`select` prunes a local file or stdin and exits 0 when it processes the input successfully. It cannot read or preserve the producer's exit status, so use `run` when exit status matters.

```sh
jevprune show <run-id> --lines 120-531
jevprune gain
```

`gain` totals the locally recorded input and output lines and estimates the removed output tokens.

The CLI task comes from `--task`, else `JEVPRUNE_TASK`, else the command itself. The plugin builds it from the last three user prompts of the session, each cut to 500 characters, plus the command.

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
result.fallbackReason; // why, on fallback and passthrough: kind is "unavailable" | "size-limit" | "not-utf8" | "document" | "secret"
```

| input | effect |
|---|---|
| `text` | the output to prune |
| `task` | the task the kept lines have to serve |
| `command` | supplies selection context |
| `exitCode` | a non-zero code passes the output through, unless the input is over `maxPruneBytes`; omitted or `null` means unknown and can be pruned |
| `protect` | `false` prunes documents, binary and credential-looking output instead of passing it through |
| `client` | a supplied Jev client; `null` disables API selection, so eligible output uses the fallback |
| `config` | overrides the loaded configuration values |
| `env` | controls configuration and the default client |
| `save` | `false` disables the run store |

`protect` defaults to on, which is a change from 0.1: `pruneOutput` and `selectLines` now pass output that reads as a document, as binary, or as a credential straight through. `protect: false` restores the 0.1 behaviour.

`pruneStream` has the same contract with `stream` replacing `text`. It holds only the head and the tail in memory, and with the run store enabled it streams the whole input there, so a stream over `maxPruneBytes` is pruned by head and tail and `show` still prints any dropped range. `FakeJevClient` is exported for tests.

`resolveTask` is synchronous as of 0.2 and returns `ResolvedTask` rather than a promise.

## How selection works

These are never pruned:

- a failure. `run` passes output through when its command exits non-zero or takes a signal. The plugin passes through when the tool reported an error, when you interrupted it, and when the command was reading a saved run back.
- output that looks like a credential, output that is not valid UTF-8, and output that reads as a document (source, Markdown, JSON, help text, a man page, a diff).
- 60 lines or fewer, untouched, with no request made.
- output over `maxPruneBytes`, in the plugin, which returns it as it came. The CLI and the library prune it by head and tail instead, and at that size the credential check is the only protection that still runs.

The rest is selected in three steps:

1. Before Jev: the last 40 lines, every line matching an error signature (`FAIL`, `error:`, `AssertionError`, `Traceback`, stack frames, `exited with code`, and similar), and the 3 lines on each side of it. Repeated identical signature lines count once.
2. The remaining lines go to Jev in windows, one yes/no question per line: is this line needed for the task? Lines scoring at or above the threshold (default 0.3) are kept.
3. Dropped runs shorter than 3 lines are kept. Longer ones collapse into one marker.

The only text jevprune adds is collapse markers and one footer.

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
| `maxPruneBytes` | `16777216` | bytes (16 MiB). In the CLI and the library, larger input gets no Jev request and is pruned by head and tail, except in `run`, where a failed or non-UTF-8 command's output is printed in full from the saved log. The plugin returns a result over the limit untouched |
| `retention.maxRuns` | `200` | maximum saved runs before the oldest are deleted |
| `retention.maxBytes` | `268435456` | maximum saved-run bytes (256 MiB) before the oldest are deleted |

The plugin reads the same file and applies the same retention limits after each pruned result.

Environment: `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `JEVPRUNE_TASK`, `JEVPRUNE_HOME` (default `~/.jevprune`).

The defaults were set on real outputs from one machine (a vitest run, a Next.js build, a docker compose startup, a pytest run, a cargo build). They are a starting point.

## Limits and data handling

- Saved run logs and metadata live under `~/.jevprune`. Retention deletes the oldest saved runs once either limit is reached, so a marker can outlive the log it points at.
- Claude Code saves a large result to a file rather than handing it to the plugin inline. The plugin reads that file back through the host, which refuses anything over 4 MiB, so a result above that size passes through whole.
- A result read back from a file is pruned to fit 16,000 characters, footer included. When raising the threshold still cannot get it under that, the plugin returns the result whole and saves no run.
- Output that looks like a credential is never left under `~/.jevprune`. When such output is also over `maxPruneBytes`, only the captured head and tail are printed and the middle is unrecoverable, because it was never saved. If the log had already been written and could not be deleted, the footer names the file still on disk: `jevprune: exit 0, 122 lines passed through (output looks like a credential, saved log could not be removed (EACCES): ~/.jevprune/runs/m1xk2p7a-3f9c.log)`.
- `gain.jsonl` is appended by read-then-write with no lock, so two results finishing at the same moment can lose an entry. That affects `gain` totals, not saved output.
- Selection sends several requests for a long output and spends input tokens on the TypeSafe account that issued the key.

## Benchmark

`bench/` compares three arms over three checked-in fixtures (a vitest run, a cargo build, a docker compose startup): the raw output, the rules-only selection, and the Jev selection. Each fixture carries a hand-written list of the line numbers an agent needs for that fixture's task, with a reason per line. Each arm reports lines, bytes, estimated tokens, request count, wall time and recall against that list.

```sh
pnpm bench
```

That prints the table. `pnpm bench --out` writes it to `bench/report.json`, and `--out <path>` writes it where you say. The Jev arm is skipped without `TYPESAFE_API_KEY`. No numbers are published here; run it with your own key.

## Neighbors

- [jev-pruner](https://github.com/tamaratran/jev-pruner) prunes Bash results from a hooks module as well, in 20-line chunks, with conversation history in its state and Codex support. jevprune's handling of persisted outputs, its document protection and its secrets guard follow what that project does. The two tools were built independently.
- [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) selects conversation content during compaction. jevprune selects lines from each command as it finishes, and also works as a CLI or library. The tools can be used together.
- [RTK](https://github.com/rtk-ai/rtk) filters output with rules written per tool. jevprune has no per-tool rules; the task decides.
- [Squeez](https://github.com/KRLabsOrg/squeez) selects task-relevant lines with a 2B model, in Python, running locally or on a server. jevprune selects through the TypeSafe API and prints dropped ranges back from its run store.

## License

MIT
