#!/bin/sh
bin="${JEVPRUNE_BIN:-}"
if [ -z "$bin" ]; then
  bin="$(command -v jevprune 2>/dev/null)" || exit 0
fi
[ -x "$bin" ] || exit 0
exec "$bin" hook
