# jevprune demo recording.
#
# Prerequisites: vhs, zsh, a built dist (pnpm exec tsup), Claude Code with a jevprune 0.2
# plugin directory, TYPESAFE_API_KEY and CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 exported in the
# shell that runs vhs (the tape exports the flag again so a bare `vhs docs/demo.tape` works).
#
# Overrides, each with a working default: JEVPRUNE_REPO (the directory vhs runs in),
# JEVPRUNE_DEMO (/tmp/checkout-service, created by docs/demo/make-project.js),
# JEVPRUNE_CLI_JS (<repo>/dist/cli.js).
#
# The --settings and --model flags on the claude wrapper are not part of the product: they keep
# an older installed jevprune plugin, the local status line and the advisor tip out of the
# frames. Drop them once 0.2 is the installed plugin.

Output docs/demo.gif

Set Shell zsh
Set FontSize 12
Set Width 1000
Set Height 620
Set Padding 10
Set TypingSpeed 28ms
Set Framerate 6
Set PlaybackSpeed 2

Hide
Type `REPO="${JEVPRUNE_REPO:-$PWD}"` Enter
Type `DEMO="${JEVPRUNE_DEMO:-/tmp/checkout-service}"` Enter
Type `CLI="${JEVPRUNE_CLI_JS:-$REPO/dist/cli.js}"` Enter
Type `node "$REPO/docs/demo/make-project.js" "$DEMO"` Enter
Type `jevprune() { node "$CLI" "$@"; }` Enter
Type `claude() { command claude --model sonnet --settings '{"enabledPlugins":{"jevprune@jevprune":false},"statusLine":{"type":"command","command":"printf \"\""},"advisorModel":""}' --plugin-dir "$REPO" "$@"; }` Enter
Type "export CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1" Enter
Type `cd "$DEMO"` Enter
Type "clear" Enter
Show
Sleep 1500ms

Type "claude plugin marketplace add ibrahemid/jevprune"
Sleep 2500ms
Ctrl+U
Sleep 500ms
Type "claude plugin install jevprune@jevprune"
Sleep 2500ms
Ctrl+U
Sleep 800ms

Type "claude"
Sleep 1s
Enter
Hide
Sleep 9s
Show
Sleep 1s

Type "Run this exact command, no pipes and no tail: npm test ."
Sleep 1500ms
Enter
Sleep 22s
Ctrl+O
Sleep 4s
Up@100ms 22
Sleep 4s
Down@100ms 22
Sleep 3s
Ctrl+O
Sleep 1500ms
Type "/exit"
Sleep 800ms
Enter
Sleep 2500ms

Hide
Type `clear; print -z "$(node "$REPO/docs/demo/show-command.js" "$DEMO")"` Enter
Show
Sleep 2500ms
Enter
Sleep 6s
