# Phase 3 — Service operation interstitial modals

**Status:** Design approved 2026-05-24 via brainstorming session.
**Targets:** v0.1.25-beta.41 (Phase 3 of the operation-server rearchitecture).
**Scope:** Add "installing service, please wait..." and "uninstalling service, please wait..." modal UI mounted during service install/uninstall API pending state. Pure cosmetic — no API changes, no new state machines. Pre-deploys the visual treatment that Phase 4 will use when the uninstall path goes live.

---

## Background

The operation-server rearchitecture (spec: `2026-05-23-operation-server-rearchitecture-design.md`) shipped Phases 1+2 (beta.39 + beta.40) and passed its VM smoke 2026-05-24. Phase 3 adds the frontend modal that gives users visual feedback during the install/uninstall API call's pending state.

Currently, clicking "Install Service" or "Uninstall Service" fires a `fetch()` and the UI freezes with no feedback until the response arrives (typically 2-5 seconds for install, 1-2s for uninstall). Phase 3 replaces that dead period with a modal showing operation text + spinner.

Per Q1b of the original spec: "A frontend interstitial modal renders 'Installing service, please wait...' during the install API call's pending state. local-Node continues to serve the page (no architectural change to install). UX symmetry with the 'Updating app' and 'Uninstalling service' pages is achieved via consistent copy and visual treatment, not shared HTTP server."

---

## Design

### Component: `ServiceOperationModal`

**File:** `src/app/client/ServiceOperationModal.ts` — follows codebase convention (general modals live in `src/app/client/`; device-specific modals in `src/app/googDevice/client/`).

**Extends** `Modal` from `src/app/ui/Modal.ts`. All modals in the codebase extend this abstract class. The base class provides:
- `<dialog>` element with `.modal` class (glassmorphism styling from `style/modal.css`)
- Header with title + theme toggle + close button
- `buildBody(container)` abstract method (subclass fills content)
- `close(result?)` with exit transition + DOM removal
- Escape key + backdrop click + close button handlers (override to customize)

**Constructor:** takes `{ operation: 'install' | 'uninstall' }`. Maps to:
- `title`: `'installing service'` or `'uninstalling service'` (lowercase per `feedback_ui_color_scheme.md`)
- The Modal base constructor appends to `document.body` and calls `showModal()` immediately — so instantiation IS showing

**`buildBody(container)`:** appends a spinner element + a `<p>` with "please wait..." text. Uses `createElement + textContent` (no innerHTML, per `feedback_html_tag_escaping.md`). Spinner reuses the existing CSS spinner pattern from `style/modal.css` if available, or adds a minimal CSS `@keyframes` animation.

**Dismiss prevention:** this modal must NOT be closeable by the user during the pending operation. Override:
- `onEscapeKey()` → no-op (prevent Escape from dismissing)
- `onBackdropClick()` → no-op (prevent click-outside from dismissing)
- `onCloseButtonClick()` → no-op (prevent X button from dismissing)

Alternatively, hide the close button entirely by setting `this.closeBtn` display to `none` in the constructor. The overrides are belt-and-suspenders.

**Caller closes** via `modal.close()` when the API responds (success or failure). The Modal base handles exit transition + DOM removal.

### Wire-in points

Three click handlers mount the modal. Pattern for each:

```ts
const modal = new ServiceOperationModal({ operation: 'install' });
try {
    const r = await fetch('/api/service/install', { method: 'POST', ... });
    // existing handling (may include navigation — modal auto-removed on page unload)
} finally {
    modal.close();
}
```

| # | File | Line | Operation | Notes |
|---|---|---|---|---|
| 1 | `src/app/client/SettingsModal.ts` | ~855 | `install` | Settings → Install Service button |
| 2 | `src/app/client/SettingsModal.ts` | ~907 | `uninstall` | Settings → Uninstall Service button |
| 3 | `src/app/client/WelcomeModal.ts` | ~320 | `install` | Welcome modal → Install Service button |

Each wire-in wraps the existing `fetch()` call — no changes to the API request itself, no changes to the response handling. The modal is purely visual.

### Tests

**File:** `src/app/client/__tests__/serviceOperationModal.test.ts` (follows existing pattern from `adminConfirmModal.test.ts`).

4 unit tests:
1. `operation='install'` renders "installing service" title + "please wait" body text
2. `operation='uninstall'` renders "uninstalling service" title + "please wait" body text
3. `close()` removes the dialog from the DOM
4. Dialog has `aria-busy="true"` for accessibility (screen readers announce the pending state)

No integration tests for the wire-in points (no frontend integration test harness exists; manual VM smoke covers this).

### Visual treatment

The modal inherits the glassmorphism card styling from the existing `style/modal.css` (same treatment as Settings, Welcome, AdminConfirm modals). Body content is centered text + spinner — mirrors the operation-server-page.html aesthetic but rendered by the live Node server, not the Rust launcher binary.

CSS variables from `reference_wsscrcpy_theme_vars.md` apply (the modal inherits them via the existing `.modal` class).

---

## Non-goals

- No API changes (Phase 4 does that — wires the uninstall marker writer)
- No changes to `launcher/assets/operation-server-page.html` (that's the Rust-served page for the port-gap window; this modal is the Node-served page for the API-pending window)
- No new state machine — the modal is a dumb loading indicator
- No frontend integration test harness for the wire-in points
- No changes to the Welcome modal's install flow beyond wrapping the fetch in a modal

---

## Implementation order

1. **Component** (`ServiceOperationModal.ts`) — TDD: failing test → implement → green
2. **Wire-in: SettingsModal install** — wrap fetch at ~line 855
3. **Wire-in: SettingsModal uninstall** — wrap fetch at ~line 907
4. **Wire-in: WelcomeModal install** — wrap fetch at ~line 320
5. **Manual smoke** — dev server: click Install Service (Settings + Welcome) + Uninstall Service, verify modal appears + dismisses
6. **CHANGELOG + version bump + PR + beta.41 cut**

Each step is independently committable. Tests pass at every commit boundary.

---

## Risks

| Risk | Mitigation |
|---|---|
| Modal base constructor calls `showModal()` immediately — if the fetch call throws synchronously before `try` block, the modal stays on screen | `finally` block guarantees `close()` fires on any exit path (return, throw, async rejection). The only edge case is a synchronous throw inside the `new ServiceOperationModal()` constructor itself, which would prevent the modal from mounting at all (no cleanup needed). |
| Uninstall flow navigates the browser (redirect to local-mode port) before `finally` fires | Browser navigation unloads the page, removing the dialog from DOM automatically. `close()` in `finally` is a no-op on an already-removed element (Modal's `close()` checks `parentElement` before removal). |
| Modal blocks the Settings modal underneath — can the user still see the Settings modal? | The ServiceOperationModal's dialog backdrop covers the whole viewport (standard `<dialog>` modal behavior). The Settings modal is behind the backdrop — correct UX since the user shouldn't interact with Settings during a pending operation. |
