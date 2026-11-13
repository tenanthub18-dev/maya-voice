# Product design system

The localized product name comes from `apps/web/lib/brand.ts`; do not duplicate it in documentation or UI copy.

The product is a front-of-house operating tool: warm enough to feel at home in a restaurant, disciplined enough to scan during service. The interface uses a paper canvas, ink text, and one deep-green accent. Decoration never competes with calls, bookings, orders, or decisions.

## Foundations

All design values live in `apps/web/styles/tokens.css`. Components consume semantic roles, never palette values.

| Role | Use |
| --- | --- |
| `--color-canvas` | Page background and quiet data regions |
| `--color-surface` | Controls, panels, sheets, and navigation |
| `--color-surface-raised` | Selected rows, grouped controls, and secondary fills |
| `--color-text` / `--color-text-muted` | Primary content / supporting content |
| `--color-border` / `--color-border-strong` | Structure / control boundaries |
| `--color-accent` / `--color-on-accent` | Primary action, active navigation, and focus of attention |
| `--color-success`, `--color-warning`, `--color-danger` | Status only; never decoration |
| `--color-focus` | Keyboard focus ring only |

Light and dark values are explicit. `data-theme="light"` and `data-theme="dark"` are stable screenshot and future user-preference hooks; the operating-system preference remains the default. New foreground/background pairs belong in `scripts/design-check.ts` so AA contrast is tested in both themes.

Inter is the UI face. Geist is loaded locally through `next/font` and reserved for page titles, the wordmark, and short display statements. Counts, money, durations, capacity, and latency use tabular numerals. Transcript text falls through Inter to Noto Nastaliq Urdu, Noto Sans Devanagari, and Noto Sans Gurmukhi. Every transcript bubble uses `dir="auto"`; use logical alignment (`ms`, `me`, `text-end`) so mixed-script lines remain correct.

Spacing follows an 8px rhythm. A 4px half-step is permitted only for optical alignment inside compact controls. Controls use an 8px radius; panels use 12px. Do not turn every section into a card: cards group one operational idea, while borders, dividers, and open canvas establish the rest of the hierarchy.

## Primitives

Import primitives from `@/components/ui`.

- `Button`, `IconButton`, `Input`, `Select`, and `Switch` own control height, focus, disabled state, and colour.
- `Tabs` and `Tab` own horizontal overflow and active-state treatment.
- `Badge` and `Chip` label compact status or taxonomy. They are not buttons.
- `Card` groups one coherent decision or operational unit.
- `Dialog` handles centred confirmation; `Sheet` handles edit flows that benefit from retained page context.
- `Toast` reports a completed background or form action. Errors that block the screen use `ErrorState`.
- `Skeleton`, `EmptyState`, and `ErrorState` are the standard loading, empty, and failure vocabulary.
- `DataTable` renders a desktop table and collapses each row into a labelled mobile card.
- `StatTile` is for a single scannable measure, never prose.
- `TranscriptBubble`, `LatencyStrip`, `CapacityBar`, and `CalendarGrid` encode restaurant-specific operational patterns.

Do not copy primitive class strings into screens. If a state or variant is missing, add it to the primitive and its quality gate. Lucide is the only icon set; use 1.75–2px visual weight and hide decorative icons from assistive technology.

## Layout rules

- **320–767px:** one content column, bottom navigation, safe-area padding, and sticky action bars above navigation. Tables collapse to labelled cards. No horizontal page scrolling.
- **768–1279px:** persistent 256px sidebar and two-pane layouts where context matters. Call detail keeps the call list beside the selected call.
- **1280px and wider:** content may grow to 1440px. Order columns and calendar days use horizontal space before adding more cards or padding.

Operational screens favour density: 8–16px gaps, dividers, short labels, and visible counts. Agent and onboarding screens favour calm: fewer columns, 24–32px section gaps, and one clear sticky next action.

## States, motion, and copy

Every data-bearing screen must define loading, empty, error, and filled states. Empty copy is one specific sentence plus one action. Error copy says what failed and offers a retry or safe exit. Do not expose raw provider errors.

Motion explains state: the live-call pulse indicates an active line, sheets enter from their attached edge, and skeletons shimmer while data is unresolved. Use `--duration-fast`, `--duration-base`, or `--duration-slow`; do not introduce arbitrary durations. `prefers-reduced-motion: reduce` disables all non-essential animation and transitions.

English and French copy is plain and specific. Avoid hype, anthropomorphic claims, and vague success language. Buttons describe the action (`Publish agent`, `Move to ready`), statuses describe current state (`Forwarding not verified`), and helper text states the consequence.

## Quality gate

Run:

```bash
arch -arm64 pnpm --filter @voice-receptionist/web test
```

Vitest executes `scripts/design-check.ts`, which audits semantic token contrast and minimum 44px tap targets in shared controls. The Playwright screenshot suite is opt-in with `SCREENSHOTS=1` and writes only to `tmp/screenshots/`.
