#!/bin/sh
set -u
cd "$(dirname "$0")/.."
status=0
run() {
  name=$1; shift
  out=$("$@" 2>&1)
  code=$?
  if [ $code -ne 0 ]; then
    status=1
    printf '%s: FAIL (exit %s)\n' "$name" "$code"
    printf '%s\n' "$out" | tail -n 60
  else
    printf '%s: ok\n' "$name"
  fi
}
run typecheck pnpm exec tsc --noEmit
run typecheck:hooks pnpm exec tsc -p tsconfig.hooks.json --noEmit
run lint pnpm exec eslint . --max-warnings 0
run test pnpm exec vitest run --reporter=dot
run build pnpm exec tsup
exit $status
