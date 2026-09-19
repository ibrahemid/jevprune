---
name: jevprune
description: "Recover output lines dropped by a [jevprune: ...] marker with jevprune show, read a jevprune footer, and run a long command through jevprune."
---

# jevprune

## What the plugin does on its own

With `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` set and a TypeSafe key configured, the plugin prunes long Bash results before they reach the model. The command is passed to the shell as written, so permission rules match it unchanged.

A pruned result ends in a footer, carries a marker wherever lines were dropped, and raises a toast:

```
jevprune: 3,104 → 88 lines, run m1xk2p7a-3f9c
```

The run id appears in the toast and in every marker; the footer carries the log path.

A result that passes through arrives exactly as the command printed it. That happens for:

- a command that failed or was interrupted
- output of 60 lines or fewer
- output over the size limit (`maxPruneBytes`, 16 MB by default)
- output that looks like a document, source, help page, JSON or a diff, or a command that reads a file, such as `cat`, `jq`, `diff` or `git show`
- output that looks like a credential
- output that is not UTF-8
- a read of `~/.jevprune/runs`
- a result the session saved to a file, when its pruned form still runs past 16,000 characters
- a session with no key

A missing key is logged once per session:

```
jevprune: TYPESAFE_API_KEY not set, results pass through
```

## Read the footer

A line starting with `jevprune:` under a command's output is a footer, not output.

- `jevprune: 3,104 → 88 lines, exit 0, full output ~/.jevprune/runs/m1xk2p7a-3f9c.log`: 3,104 lines were captured, 88 were printed, the command exited 0, and the full output is at that path.
- `jevprune: fallback (Jev unavailable: <reason>), ...`: Jev could not be reached, so the first and last lines, error signatures, and their surrounding context were kept.
- `jevprune: fallback (output over <n> bytes), ...`: the output ran past the size limit, so the same first and last lines, error signatures and context were kept, with no Jev request.
- `jevprune: exit 1, 3,104 lines passed through, ...`: nothing was dropped.
- `jevprune: 2,979 lines passed through (output looks like a document)` and `jevprune: 41 lines passed through (output looks like a credential, full output was not saved)`: `select` prints these, `run` prints the same with `exit <n>` before the count, and the plugin prints nothing when it passes a result through.
- `..., full output was not saved (<code>)`: the run log could not be written, so dropped lines cannot be recovered.

No footer means nothing was dropped.

## Recover dropped lines

`[jevprune: 412 lines dropped, run m1xk2p7a-3f9c, lines 120-531]` marks where lines were removed. Print them with:

```
jevprune show m1xk2p7a-3f9c --lines 120-531
```

`jevprune show <id>` prints the whole run. A dropped line can be one that mattered, so read the range before concluding that something is absent from the output.

Without the `jevprune` binary, read the range from the log path in the footer:

```
sed -n '120,531p' ~/.jevprune/runs/m1xk2p7a-3f9c.log
```

## Run a long command through jevprune

For a command whose output runs long (a test suite, a build, a container startup) when the plugin is not pruning:

```
jevprune run --task "<task>" -- <command> [args...]
```

`run` takes an executable and its arguments, with no shell. For a pipeline, a redirect or any other shell syntax, wrap the command:

```
jevprune run --task "<task>" -- bash -c '<command> 2>&1'
```

The exit code is the command's own. Short output and output from a failed command are printed in full, unless the output ran past the size limit and its run log could not be saved.

For output that is already in a file:

```
jevprune select --task "<task>" --file build.log
```

`select` reports its own exit status, not the status of the command that wrote the file. Prefer `run` when the exit status matters.
