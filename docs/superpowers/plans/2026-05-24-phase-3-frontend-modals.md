# Phase 3 — Service Operation Interstitial Modals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "installing service, please wait..." and "uninstalling service, please wait..." modal UI during service install/uninstall API pending state.

**Architecture:** New `ServiceOperationModal extends Modal` (the existing abstract base from `src/app/ui/Modal.ts`). Instantiation shows the modal (base class calls `showModal()` in its constructor). Caller closes via `modal.close()` in a `using` dispose declaration on every exit path. Three wire-in points in SettingsModal + WelcomeModal.

**Tech Stack:** TypeScript, vitest + jsdom, webpack. `Modal` base class lifecycle.

**Key codebase constraint (`feedback_es2022_class_fields.md`):** `useDefineForClassFields: true` means class fields are initialized AFTER `super()`. The `Modal` base constructor calls `buildBody()` during `super()`, so subclass instance fields are `undefined` inside `buildBody()`. Workaround: set a module-scoped variable before `super()` and read it in `buildBody()`. This is the same pattern documented in the operational memory for this project.

---

## File structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/app/client/ServiceOperationModal.ts` | create | Modal component |
| `src/app/client/__tests__/serviceOperationModal.test.ts` | create | Unit tests (6 cases) |
| `src/style/modal.css` | modify | `.service-operation-modal` overrides + spinner |
| `src/app/client/SettingsModal.ts` | modify | Wire modal into install (~line 854) + uninstall (~line 906) |
| `src/app/client/WelcomeModal.ts` | modify | Wire modal into install (~line 319) |
| `CHANGELOG.md` | modify | Unreleased entry |

---

## Task 1: Create ServiceOperationModal component (TDD)

**Files:**
- Create: `src/app/client/ServiceOperationModal.ts`
- Create: `src/app/client/__tests__/serviceOperationModal.test.ts`
- Modify: `src/style/modal.css`

- [ ] **Step 1: Write failing test**

Create `src/app/client/__tests__/serviceOperationModal.test.ts`:

```ts
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceOperationModal } from '../ServiceOperationModal';

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        if (this.hasAttribute('open')) {
            throw new DOMException(
                "Failed to execute 'showModal' on 'HTMLDialogElement': The element already has an 'open' attribute, and therefore cannot be opened modally.",
                'InvalidStateError',
            );
        }
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
});

afterEach(() => {
    document.body.replaceChildren();
});

describe('ServiceOperationModal', () => {
    it('install: title is "installing service"', () => {
        new ServiceOperationModal({ operation: 'install' });
        expect(document.querySelector('.modal-title')!.textContent).toBe('installing service');
    });

    it('uninstall: title is "uninstalling service"', () => {
        new ServiceOperationModal({ operation: 'uninstall' });
        expect(document.querySelector('.modal-title')!.textContent).toBe('uninstalling service');
    });

    it('body contains "please wait" text', () => {
        new ServiceOperationModal({ operation: 'install' });
        expect(document.querySelector('.modal-body')!.textContent).toContain('please wait');
    });

    it('close() closes the dialog', () => {
        const modal = new ServiceOperationModal({ operation: 'install' });
        const dialog = document.querySelector('dialog')!;
        expect(dialog.hasAttribute('open')).toBe(true);
        modal.close();
        expect(dialog.hasAttribute('open')).toBe(false);
    });

    it('escape key does not dismiss the modal', () => {
        new ServiceOperationModal({ operation: 'install' });
        const dialog = document.querySelector('dialog')!;
        const event = new Event('cancel', { cancelable: true });
        dialog.dispatchEvent(event);
        expect(dialog.hasAttribute('open')).toBe(true);
    });

    it('dialog has service-operation-modal class', () => {
        new ServiceOperationModal({ operation: 'install' });
        expect(document.querySelector('dialog')!.classList.contains('service-operation-modal')).toBe(true);
    });
});
```

This follows the `AdminConfirmModal.test.ts` pattern: `@vitest-environment jsdom`, `showModal`/`close` stubs matching the HTML spec, `replaceChildren()` cleanup.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/client/__tests__/serviceOperationModal.test.ts`
Expected: FAIL — module `../ServiceOperationModal` does not exist.

- [ ] **Step 3: Create `ServiceOperationModal.ts`**

Create `src/app/client/ServiceOperationModal.ts`:

```ts
import { Modal } from '../ui/Modal';

export interface ServiceOperationModalOptions {
    operation: 'install' | 'uninstall';
}

const OPERATION_TEXT: Record<ServiceOperationModalOptions['operation'], { title: string; body: string }> = {
    install: { title: 'installing service', body: 'please wait while the service is installed...' },
    uninstall: { title: 'uninstalling service', body: 'please wait while the service is uninstalled...' },
};

// Module-scoped staging variable. buildBody() runs during super() — before
// subclass fields are initialized (useDefineForClassFields). Set this before
// super() so buildBody() can read the body text.
let _pendingBody = '';

export class ServiceOperationModal extends Modal {
    constructor(opts: ServiceOperationModalOptions) {
        const text = OPERATION_TEXT[opts.operation];
        _pendingBody = text.body;
        super({ title: text.title });
    }

    protected override buildBody(container: HTMLElement): void {
        this.dialog.classList.add('service-operation-modal');

        const spinner = document.createElement('div');
        spinner.className = 'service-operation-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        container.appendChild(spinner);

        const p = document.createElement('p');
        p.textContent = _pendingBody;
        container.appendChild(p);
    }

    protected override onEscapeKey(): void {}
    protected override onBackdropClick(): void {}
    protected override onCloseButtonClick(): void {}
}
```

- [ ] **Step 4: Add CSS for `.service-operation-modal`**

Append to the END of `src/style/modal.css`:

```css
/* --- Service operation modal (Phase 3) --- */

dialog.service-operation-modal .modal-header-controls {
    display: none;
}

dialog.service-operation-modal .modal-body {
    text-align: center;
    padding: 1rem 0;
}

.service-operation-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border-muted, rgba(255, 255, 255, 0.2));
    border-top-color: var(--accent, #5b9aff);
    border-radius: 50%;
    margin: 0 auto 1rem;
    animation: service-op-spin 0.8s linear infinite;
}

@keyframes service-op-spin {
    to { transform: rotate(360deg); }
}
```

CSS vars `--border-muted` and `--accent` are from `reference_wsscrcpy_theme_vars.md`. The fallback values match the operation-server-page.html's visual treatment.

`dialog.service-operation-modal .modal-header-controls { display: none; }` hides the close button + theme toggle — the user should not dismiss a pending operation.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/app/client/__tests__/serviceOperationModal.test.ts`
Expected: 6 tests pass.

- [ ] **Step 6: Run BOTH gates**

```bash
npx tsc --noEmit    # MUST be clean
npm test            # note exact test count (expect baseline + 6)
```

- [ ] **Step 7: Commit**

```powershell
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client/ServiceOperationModal.ts src/app/client/__tests__/serviceOperationModal.test.ts src/style/modal.css
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(frontend): ServiceOperationModal — install/uninstall interstitial component"
```

---

## Task 2: Wire modal into SettingsModal install handler

**Files:**
- Modify: `src/app/client/SettingsModal.ts` (~lines 1 and 854)

- [ ] **Step 1: Add import**

At the top of `src/app/client/SettingsModal.ts`, add the import alongside the existing imports from the same directory:

```ts
import { ServiceOperationModal } from './ServiceOperationModal';
```

- [ ] **Step 2: Wire modal into `onInstallService`**

Find the install handler (around line 854). The CURRENT code has:

```ts
        try {
            const r = await fetch('/api/service/install', {
```

Insert TWO lines BEFORE the `try {`:

```ts
        const modal = new ServiceOperationModal({ operation: 'install' });
        using _closeModal = { [Symbol.dispose](): void { modal.close(); } };
        try {
            const r = await fetch('/api/service/install', {
```

The `using _closeModal` declaration calls `modal.close()` on every exit path (return, throw, fall-through) — same `using`-declaration pattern already used for `_restoreBtn` in this method.

Do NOT modify the existing `try` block, the `_restoreBtn` declaration, or any response handling. The modal is a visual overlay only.

- [ ] **Step 3: Run BOTH gates**

```bash
npx tsc --noEmit    # MUST be clean
npm test            # test count unchanged from Task 1
```

- [ ] **Step 4: Commit**

```powershell
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client/SettingsModal.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(frontend): mount ServiceOperationModal during Settings install API call"
```

---

## Task 3: Wire modal into SettingsModal uninstall handler

**Files:**
- Modify: `src/app/client/SettingsModal.ts` (~line 906)

- [ ] **Step 1: Wire modal into `onUninstallService`**

Find the uninstall handler (around line 906). The CURRENT code has:

```ts
        try {
            const r = await fetch('/api/service/uninstall', { method: 'POST' });
```

Insert TWO lines BEFORE the `try {`:

```ts
        const modal = new ServiceOperationModal({ operation: 'uninstall' });
        using _closeModal = { [Symbol.dispose](): void { modal.close(); } };
        try {
            const r = await fetch('/api/service/uninstall', { method: 'POST' });
```

The import already exists from Task 2. The `AdminConfirmModal.confirm()` gate at the top of `onUninstallService` runs BEFORE the modal — if the user cancels confirmation, the modal never mounts. Correct behavior.

- [ ] **Step 2: Run BOTH gates**

```bash
npx tsc --noEmit    # MUST be clean
npm test            # test count unchanged
```

- [ ] **Step 3: Commit**

```powershell
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client/SettingsModal.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(frontend): mount ServiceOperationModal during Settings uninstall API call"
```

---

## Task 4: Wire modal into WelcomeModal install handler

**Files:**
- Modify: `src/app/client/WelcomeModal.ts` (~lines 1 and 319)

- [ ] **Step 1: Add import**

At the top of `src/app/client/WelcomeModal.ts`:

```ts
import { ServiceOperationModal } from './ServiceOperationModal';
```

- [ ] **Step 2: Wire modal into the install section**

Find the install fetch (around line 319). The CURRENT code has:

```ts
        try {
            const r = await fetch('/api/service/install', {
```

Insert TWO lines BEFORE the `try {`:

```ts
        const modal = new ServiceOperationModal({ operation: 'install' });
        using _closeModal = { [Symbol.dispose](): void { modal.close(); } };
        try {
            const r = await fetch('/api/service/install', {
```

- [ ] **Step 3: Run BOTH gates**

```bash
npx tsc --noEmit    # MUST be clean
npm test            # test count unchanged
```

- [ ] **Step 4: Commit**

```powershell
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client/WelcomeModal.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(frontend): mount ServiceOperationModal during Welcome install API call"
```

---

## Task 5: Build + manual smoke + CHANGELOG + PR

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Build the frontend**

```powershell
cd C:/Users/jscha/source/repos/ws-scrcpy-web
npm run build
```

Expected: webpack completes with no errors.

- [ ] **Step 2: Start dev server and smoke**

```powershell
npm start
```

Open `http://localhost:8000/` → Settings → Dependencies panel (confirm the dep-update-gate from earlier is still working — disabled "update (dev)" button for nodejs/adb).

Navigate to Settings → Service section:
- Click "Install Service" → **verify**: modal appears with "installing service" title + spinner + "please wait" text. Header has no close button. Clicking backdrop does nothing. Pressing Escape does nothing. After the API responds (success or failure), the modal dismisses and normal flow resumes.
- After service is installed, click "Uninstall Service" → confirmation modal appears first (AdminConfirmModal). Click "Continue" → **verify**: ServiceOperationModal appears with "uninstalling service" title. Same behavior: non-dismissible, auto-closes on response.

If testing Welcome modal: clear `config.json` `firstRunComplete` or use a fresh profile → verify the Welcome modal's "Install Service" button also shows the ServiceOperationModal.

- [ ] **Step 3: Stop dev server**

Ctrl+C.

- [ ] **Step 4: Remeasure test counts**

```bash
npm test
```

Record exact count for CHANGELOG.

- [ ] **Step 5: Add CHANGELOG entry**

Under `## [Unreleased]` → `### Added`:

```markdown
- **Service install/uninstall interstitial modals (Phase 3).** New `ServiceOperationModal extends Modal` renders "installing service, please wait..." or "uninstalling service, please wait..." during pending API state. Mounted on click, closed via `using` dispose declaration on every exit path. Three wire-in points: Settings install + Settings uninstall + Welcome install. Non-dismissible (escape / backdrop / close button overridden as no-ops). Visual parity with the launcher-served operation-server page. DOM constructed safely via createElement + textContent (no innerHTML).

Tests: vitest <NNN>/<NNN> (+6 new in serviceOperationModal.test.ts).
```

Fill in `<NNN>` from Step 4.

- [ ] **Step 6: Commit CHANGELOG**

```powershell
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add CHANGELOG.md
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "docs(changelog): Phase 3 service operation interstitial modals"
```

- [ ] **Step 7: Push + PR + auto-merge**

```powershell
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" push -u origin feat/phase-3-service-operation-modals
```

Create PR:

```powershell
gh pr create --repo bilbospocketses/ws-scrcpy-web --title "feat(frontend): Phase 3 — service operation interstitial modals" --body "$(cat <<'EOF'
## Summary

- Phase 3 of the operation-server rearchitecture. New `ServiceOperationModal extends Modal` renders "installing/uninstalling service, please wait..." during pending API state.
- Three wire-in points: Settings install (~line 854), Settings uninstall (~line 906), Welcome install (~line 319). Each uses a `using` dispose declaration for cleanup.
- Non-dismissible during pending op (escape / backdrop / close button overridden as no-ops). CSS hides header controls.
- Visual parity with the launcher-served operation-server page (spinner + centered text + glassmorphism card).

## Test plan

- [x] `npx tsc --noEmit` clean
- [x] `npm test` — +6 new tests (serviceOperationModal.test.ts)
- [x] Manual smoke: Settings install + uninstall + Welcome install — modal appears, non-dismissible, auto-closes on response

Spec: `docs/superpowers/specs/2026-05-24-phase-3-frontend-modals-design.md`
Plan: `docs/superpowers/plans/2026-05-24-phase-3-frontend-modals.md`
EOF
)"
gh pr merge --repo bilbospocketses/ws-scrcpy-web --squash --delete-branch --auto
```

- [ ] **Step 8: Version bump + tag beta.41**

After PR merges:

```powershell
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" checkout main
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" pull
npm run version:bump 0.1.25-beta.41
```

Push the version-bump commit + tag per `reference_wsscrcpy_version_bump.md`. This triggers `release.yml` to build + publish beta.41.

---

## Self-review

Spec coverage:

| Spec section | Task |
| --- | --- |
| Component: ServiceOperationModal extends Modal | Task 1 |
| buildBody + spinner + text | Task 1 Step 3 |
| Dismiss prevention (escape/backdrop/close) | Task 1 Step 3 |
| CSS: hide header controls + spinner animation | Task 1 Step 4 |
| Tests: 6 unit tests | Task 1 Step 1 |
| Wire-in: SettingsModal install | Task 2 |
| Wire-in: SettingsModal uninstall | Task 3 |
| Wire-in: WelcomeModal install | Task 4 |
| Manual smoke | Task 5 Step 2 |
| CHANGELOG | Task 5 Step 5 |
| Visual parity with operation-server page | Task 1 Step 4 (CSS vars) |
| No API changes | ✅ (no server-side tasks) |

All spec sections have an implementing task. No placeholders. Type names consistent (`ServiceOperationModal`, `ServiceOperationModalOptions`, `operation: 'install' | 'uninstall'`).
