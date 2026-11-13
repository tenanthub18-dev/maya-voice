# 037 Prove the unmeasured PRD numbers (no third parties)
Add automated tests/scripts (keep CI-stable; use generous-but-meaningful thresholds and print measured values):
1. F9: availability check over a seeded month (1,000 bookings) completes < 150 ms p95 over 200 runs; both mock data source and the SQL function path under PGlite (document if PGlite is slower and what the real budget implies).
2. F13: /calls/[id] server render with a 10-minute transcript (~200 turns + metrics) < 2 s in mock mode; assert no N+1 (count data-source calls).
3. F10: tax table test for EVERY province/territory in the worker table vs hand-calculated fixtures (13 jurisdictions, incl. QC GST+QST and BC PST exemption note); web `calculateOrderTotals` agrees with the worker for the same inputs via a shared fixture.
4. F14: analytics numbers equal raw call rows (exists: extend with heat map and funnel assertions if missing).
5. F4: "live calls use a new published version within 60 s": test the worker's agent-config cache TTL <= 60 s and a publish invalidates it.
6. F11: STOP handling test across all keyword variants blocks only that restaurant's number pair, and START re-enables.
7. Accessibility: automated axe run (existing a11y test harness) over every route's four states at 375 and 1280 widths where jsdom allows; fail on serious violations.
Write results table to docs/GATES.md (gate, threshold, measured, pass/fail).

VERIFY: cd /Users/sudhir/vibecoding && arch -arm64 pnpm --filter @voice-receptionist/web typecheck && arch -arm64 pnpm --filter @voice-receptionist/web lint && arch -arm64 pnpm --filter @voice-receptionist/web test && arch -arm64 pnpm --filter @voice-receptionist/web build && cd apps/worker && arch -arm64 uv run pytest -q
