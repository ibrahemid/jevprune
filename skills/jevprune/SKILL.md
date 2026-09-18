---
name: jevprune
description: Read a jevprune footer, recover output lines it dropped with jevprune show, and run jevprune by hand when the hook is off.
---

# jevprune

A line starting with `jevprune:` under a command's output is a footer, not output. It reports what was pruned.

- `jevprune: 3,104 → 88 lines, exit 0, full output ~/.jevprune/runs/m4x2k1-9f3a.log`: 3,104 lines were captured, 88 were printed, the command exited 0, and the full output is at that path.
- `jevprune: fallback (no Jev: <reason>), ...`: Jev was unavailable, so only the first lines, the last lines and the error lines were kept.
- `jevprune: exit 1, 3,104 lines passed through, ...`: nothing was dropped.
- `..., run store unavailable (<code>)`: the full output was not saved, so dropped lines cannot be recovered.

No footer means nothing was dropped.

## Recover dropped lines

`[jevprune: 96 lines dropped, run m4x2k1-9f3a, lines 6-101]` marks where lines were removed. Print them with:

```
jevprune show m4x2k1-9f3a --lines 6-101
```

`jevprune show <id>` prints the whole run. A dropped line can be one that mattered, so read the range before concluding that something is absent from the output.

## Run it directly

When the hook is off (`autoWrap` is false, or the plugin is not installed):

```
jevprune run --task "<task>" -- <command> [args...]
```

For output you already have:

```
<command> 2>&1 | jevprune select --task "<task>"
```
