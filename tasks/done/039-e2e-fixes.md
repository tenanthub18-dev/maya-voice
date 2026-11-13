# 039 — make e2e journey green (real bugs surfaced by 038)
Context: `pnpm --filter @voice-receptionist/web test:e2e` runs OUTSIDE the Codex sandbox only (localhost EPERM inside). Do NOT run it; fix by reading code + logs in tmp/v-e2e4.log, apps/web/test-results/*/error-context.md. Claude re-runs it afterwards.
Already fixed by Claude: onboarding allowlist (testCallAcknowledged, number), test button label 'Finish setup', toHaveTitle wait in e2e/journey.spec.ts.
Remaining failures (all 3 viewports):
1. axe `document-title` ("Document does not have a non-empty <title>") on /onboarding/2 and /onboarding/5 right after client-side navigation, even though root app/layout.tsx generateMetadata sets a title. Find the root cause (e.g. title missing during soft-nav streaming, or title element swapped during hydration) and fix in app code (e.g. per-page generateMetadata for onboarding/[step] with a translated step title), not by weakening the test.
2. e2e/journey.spec.ts: `getByText('+19705555098')` strict-mode violation (2 elements) — make the locator specific (e.g. within the number card / .first() only if both are legit) without loosening assertions.
3. An `expect(locator).toBeVisible()` failure — read tmp/v-e2e4.log for which locator; fix the app if the UI is genuinely missing, the test if the locator is wrong.
Constraints: no TODOs/mocks outside tests, no assertion loosening, surgical changes. Cite docs URL in comments for any new API.
VERIFY: cd /Users/sudhir/vibecoding && arch -arm64 pnpm --filter @voice-receptionist/web typecheck && arch -arm64 pnpm --filter @voice-receptionist/web lint && arch -arm64 pnpm --filter @voice-receptionist/web test
