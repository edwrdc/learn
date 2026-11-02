# Thread guide parity fix

Request: restore baseline cluster/chain tree guides and harden the existing
chain visuals browser check; produce report under
`/tmp/learn-frontend-migration/thread-fix/`.

Constraints: edit only `src/lib/home/ChainTableOverlay.svelte` and
`tests/browser/frontend-suite-deferred.mjs`; main checkout read-only; no
commits; no new deps; run build/browser under
`flock -o /tmp/learn-frontend-migration/worktree-check.lock`.

Status: COMPLETE. Report and ledger written. All gates green.

Final result:
- Source `1c85ac10...dc1cc13`: two guide divs, old classes/conditions, old DOM
  order (guide before row), `aria-hidden="true"` added.
- Test `57d0d23e...c945ae7`: geometry/style/accessibility assertions for both
  guides, pre-expansion absence, one helper line finds the row via `div.flex`.
- Negative: preserved pre-fix payload `3ff7e58d...` / `4ae75f29...`, hardened
  suite 38 PASS / 1 FAIL with "the expanded cluster lost its baseline tree
  thread"; log `logs/negative-old-payload.log`.
- Positive: payload `3ff7e58d...` / `52a77f0f...`, 39/39 checks, optimistic
  PASS, typecheck 0/0, lint exit 0, autofixer 0 issues.
- Known listed contract holes: 0.

Artifacts: `/tmp/learn-frontend-migration/thread-fix/report.md`,
`ledger-addendum.tsv`, `minimal-source.diff`, `minimal-test.diff`, `logs/`,
`diff-work/pre/` (hashes match parity-finish baseline).
