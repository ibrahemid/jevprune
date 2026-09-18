---
name: jevprune
description: Run a long command through jevprune, read its footer, and recover output lines it dropped with jevprune show.
---

# jevprune

## Run a long command through jevprune

For a command whose output runs long (a test suite, a build, a container startup):

```
jevprune run --task "<task>" -- <command> [args...]
```

`run` takes an executable and its arguments, with no shell. For a pipeline, a redirect or any other shell syntax, wrap the command:

```
jevprune run --task "<task>" -- bash -c '<command> 2>&1'
```

The exit code is the command's own. Short output and output from a failed command are printed in full.

For output that is already in a file:

```
jevprune select --task "<task>" --file build.log
```

`select` reports its own exit status, not the status of the command that wrote the file. Prefer `run` when the exit status matters.

## Read the footer

A line starting with `jevprune:` under a command's output is a footer, not output. It reports what was pruned.

- `jevprune: 3,104 → 88 lines, exit 0, full output ~/.jevprune/runs/m4x2k1-9f3a.log`: 3,104 lines were captured, 88 were printed, the command exited 0, and the full output is at that path.
- `jevprune: fallback (Jev unavailable: <reason>), ...`: Jev was unavailable, so the first and last lines, error signatures, and their surrounding context were kept.
- `jevprune: exit 1, 3,104 lines passed through, ...`: nothing was dropped.
- `..., full output was not saved (<code>)`: the run log could not be written, so dropped lines cannot be recovered.

No footer means nothing was dropped.

## Recover dropped lines

`[jevprune: 96 lines dropped, run m4x2k1-9f3a, lines 6-101]` marks where lines were removed. Print them with:

```
jevprune show m4x2k1-9f3a --lines 6-101
```

`jevprune show <id>` prints the whole run. A dropped line can be one that mattered, so read the range before concluding that something is absent from the output.
