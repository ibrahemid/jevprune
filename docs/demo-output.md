# Full demo output

Recorded from a source checkout against `test/fixtures/npm-test.log`, a 2,979-line vitest run with one failing test in `src/auth/login.test.ts` and a handful of slow tests. Run IDs are generated locally, so a local run prints different ones.

## Task: fix the failing auth test

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

## Task: why is the build slow

```sh
jevprune select --task "why is the build slow" --command "npm test" --file test/fixtures/npm-test.log
```

Lines 53 to 78 of the 347 it printed:

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

The footer of that run:

```
jevprune: 2,979 → 347 lines, full output ~/.jevprune/runs/mu6ln5j9-4968.log
```

The first task keeps the failure block and the auth lines around it. The second keeps the timing lines instead. Neither view rewrote a line.

## Recovering a dropped range

```sh
jevprune show mu6ln7nv-3cb9 --lines 55-57
```

```
[deprecation] `fetchJson` is deprecated, use `http.get` instead

 ✓ src/api/errors.test.ts > errors > merges the sort order 3ms
```
