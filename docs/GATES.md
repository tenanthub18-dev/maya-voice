# Automated PRD gates

Measured on 2026-10-27 on the local ARM64 CI-equivalent toolchain. Performance tests warm the exercised path before collecting samples and print fresh measurements on every run; the values below are the latest verification run, not fixed test expectations.

| Gate | Threshold | Measured | Result |
| --- | --- | --- | --- |
| F9 mock availability | p95 < 150 ms over 200 runs with 1,000 bookings across a seeded month | 2.341 ms p95 | PASS |
| F9 PGlite SQL availability function | p95 < 150 ms over 200 runs with 1,000 bookings across a seeded month | 0.554 ms p95 | PASS |
| F13 `/calls/[id]` server render | < 2,000 ms for 200 transcript turns plus 100 metric rows | 63.107 ms; exactly 5 data-source calls (one each for calls, turns, metrics, bookings, and orders) | PASS |
| F10 restaurant tax table | Exact hand calculation for all 13 provinces and territories | 13/13 exact; QC 5% GST + 9.975% QST; BC fixture records the restaurant-meal PST exemption | PASS |
| F14 analytics | Aggregates equal raw fixture rows | 5/5 calls represented in headline, outcome funnel, language, transfer, and 7×24 heat-map assertions | PASS |
| F4 published agent freshness | Cache TTL ≤ 60 s; publish invalidates the affected key | 60.000 s maximum; affected key reloads immediately while other restaurant keys stay cached | PASS |
| F11 SMS consent | Every supported exact STOP variant blocks only one restaurant/number pair; START re-enables it | 12/12 STOP representations and 4/4 START/UNSTOP representations; cross-restaurant and cross-number rows preserved | PASS |
| Accessibility | No serious or critical axe violations for every jsdom-renderable route/state at 375 px and 1280 px | 132 route/state/viewport scans; 0 serious or critical violations | PASS |

## Measurement interpretation

- The mock and PGlite F9 measurements isolate application and SQL execution. PGlite is embedded and was faster in this run; it does not model PostgREST authentication or network time. The production budget therefore remains end-to-end: database execution, Supabase/PostgREST, and network together must remain below 150 ms. The embedded SQL result leaves approximately 149 ms for those production-only layers, but a hosted load check is still required before launch.
- F13 is mock-mode server rendering by design. It catches rendering regressions and N+1 data-source reads, not hosted network latency.
- jsdom cannot calculate real layout, media-query rendering, browser focus behavior, or colour contrast. The automated route matrix disables axe's colour-contrast rule and keeps those checks in the existing executable contrast audit and browser E2E suite. Routes without collection data explicitly omit the non-applicable empty state; filled, loading, and error states are still scanned at both widths.
- Timing thresholds are intentionally generous enough for shared CI while still enforcing the PRD budgets. A failing measurement prints its observed value for diagnosis.
