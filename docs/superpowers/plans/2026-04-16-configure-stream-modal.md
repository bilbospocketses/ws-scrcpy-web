# Configure Stream Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the left-pinned sidebar configure stream dialog with a centered glassmorphism modal overlay.

**Architecture:** Rewrite `ConfigureScrcpy.createUI()` and replace `dialog.css`. All logic methods (probe, codec detection, settings persistence, buildVideoSettings, openStream) stay unchanged. The modal shell, layout structure, advanced toggle, and visual styling are new. No new files — this is a rewrite of two existing files plus minor updates to one more.

**Tech Stack:** TypeScript (DOM manipulation), CSS (glassmorphism, animations, grid layout)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/style/dialog.css` | Rewrite | All modal styles: shell, glassmorphism, layout, advanced toggle animation, controls grid, buttons, status colors |
| `src/app/googDevice/client/ConfigureScrcpy.ts` | Modify | Rewrite `createUI()` (lines 460-641), update `setStatus()` (lines 239-249), update `removeUI()` (lines 643-651) |
| `src/app/googDevice/client/StreamClientScrcpy.ts` | No change | Constructor API unchanged, no modifications needed |

---

### Task 1: Replace dialog.css with glassmorphism modal styles

**Files:**
- Rewrite: `src/style/dialog.css`

This replaces the entire file. The old CSS was 145 lines for a left-pinned sidebar. The new CSS covers: backdrop with blur, centered modal container with glass effect, header/body/footer layout, controls grid, advanced toggle animation, button styles, status colors, responsive sizing, and scrollable body.

- [ ] **Step 1: Write the new dialog.css**

Replace the entire contents of `src/style/dialog.css` with:

```css
/* ── Modal backdrop ── */
.dialog-background {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    z-index: 10;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: modal-fade-in 0.2s ease-out;
}

@keyframes modal-fade-in {
    from { opacity: 0; }
    to { opacity: 1; }
}

/* ── Modal container (glass effect) ── */
.dialog-container {
    font-family: monospace;
    width: clamp(400px, 50vw, 650px);
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    background: rgba(30, 35, 45, 0.85);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    overflow: hidden;
    animation: modal-slide-in 0.2s ease-out;
}

@keyframes modal-slide-in {
    from { opacity: 0; transform: scale(0.96) translateY(8px); }
    to { opacity: 1; transform: scale(1) translateY(0); }
}

[data-theme="light"] .dialog-container {
    background: rgba(245, 248, 252, 0.92);
    border: 1px solid rgba(0, 0, 0, 0.1);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
}

.dialog-container button,
.dialog-container select,
.dialog-container input {
    font-family: monospace;
    font-size: var(--font-size);
}

.dialog-container select {
    text-overflow: ellipsis;
}

/* ── Header ── */
.dialog-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
}

[data-theme="light"] .dialog-header {
    border-bottom-color: rgba(0, 0, 0, 0.08);
}

.dialog-header .dialog-title {
    font-size: 15px;
    font-weight: 600;
}

.dialog-header .close-btn {
    background: transparent;
    border: none;
    color: var(--text-color-light, #888);
    cursor: pointer;
    padding: 4px;
    line-height: 1;
    font-size: 18px;
}

.dialog-header .close-btn:hover {
    color: var(--text-color, #ddd);
}

/* ── Body (scrollable) ── */
.dialog-body {
    padding: 1rem;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
}

/* ── Controls grid ── */
.dialog-controls {
    display: grid;
    grid-template-columns: [labels] 35% [controls] 65%;
    gap: 0.5rem 0.75rem;
    align-items: center;
}

.dialog-controls .label {
    grid-column: labels;
    color: var(--text-color-light, #888);
    font-size: 13px;
}

.dialog-controls .input,
.dialog-controls select,
.dialog-controls input:not([type="checkbox"]) {
    grid-column: controls;
    box-sizing: border-box;
    background: var(--stream-bg-color, #1a1a2e);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: var(--text-color, #ddd);
    padding: 4px 8px;
}

[data-theme="light"] .dialog-controls select,
[data-theme="light"] .dialog-controls input:not([type="checkbox"]) {
    background: #fff;
    border-color: rgba(0, 0, 0, 0.15);
    color: #333;
}

.dialog-controls select:focus,
.dialog-controls input:focus {
    outline: none;
    border-color: #5b9aff;
}

/* ── Slider value labels ── */
.dialog-controls .range-label {
    grid-column: labels;
    color: var(--text-color-light, #888);
    font-size: 13px;
}

.dialog-controls input[type="range"] {
    grid-column: controls;
    width: 100%;
    cursor: pointer;
}

/* ── Advanced toggle ── */
.advanced-separator {
    grid-column: 1 / -1;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    margin-top: 0.5rem;
    padding-top: 0.5rem;
}

[data-theme="light"] .advanced-separator {
    border-top-color: rgba(0, 0, 0, 0.08);
}

.advanced-toggle {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    padding: 0.25rem 0;
    color: var(--text-color-light, #888);
    font-size: 13px;
    user-select: none;
    background: transparent;
    border: none;
    width: 100%;
    font-family: monospace;
}

.advanced-toggle:hover {
    color: var(--text-color, #ddd);
}

.advanced-toggle .chevron {
    transition: transform 0.3s ease;
    font-size: 12px;
}

.advanced-toggle .chevron.expanded {
    transform: rotate(180deg);
}

/* ── Advanced section (animated reveal) ── */
.advanced-section {
    grid-column: 1 / -1;
    display: grid;
    grid-template-columns: [labels] 35% [controls] 65%;
    gap: 0.5rem 0.75rem;
    align-items: center;
    overflow: hidden;
    max-height: 0;
    opacity: 0;
    transition: max-height 0.3s ease, opacity 0.3s ease, margin 0.3s ease;
    margin-top: 0;
}

.advanced-section.expanded {
    max-height: 300px;
    opacity: 1;
    margin-top: 0.5rem;
}

.advanced-section .label {
    grid-column: labels;
    color: var(--text-color-light, #888);
    font-size: 13px;
}

.advanced-section .input,
.advanced-section select,
.advanced-section input:not([type="checkbox"]) {
    grid-column: controls;
    box-sizing: border-box;
    background: var(--stream-bg-color, #1a1a2e);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: var(--text-color, #ddd);
    padding: 4px 8px;
}

[data-theme="light"] .advanced-section select,
[data-theme="light"] .advanced-section input:not([type="checkbox"]) {
    background: #fff;
    border-color: rgba(0, 0, 0, 0.15);
    color: #333;
}

/* ── Fit to screen toggle ── */
.fit-toggle-wrapper {
    grid-column: controls;
    display: flex;
    align-items: center;
}

/* ── Settings buttons ── */
.dialog-settings {
    display: flex;
    gap: 8px;
    justify-content: center;
    margin-top: 1rem;
    padding-top: 0.75rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
}

[data-theme="light"] .dialog-settings {
    border-top-color: rgba(0, 0, 0, 0.08);
}

.dialog-settings button {
    border: 0.5px solid var(--text-color, #ddd);
    border-radius: 6px;
    background: transparent;
    color: #5b9aff;
    padding: 6px 16px;
    cursor: pointer;
    white-space: nowrap;
}

.dialog-settings button:hover {
    background: var(--device-list-hover-color, hsl(218, 17%, 18%));
}

/* ── Footer ── */
.dialog-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
}

[data-theme="light"] .dialog-footer {
    border-top-color: rgba(0, 0, 0, 0.08);
}

.dialog-footer .status-text {
    font-size: 13px;
}

.dialog-footer .status-text.status-probing {
    color: #f06c75;
}

.dialog-footer .status-text.status-ready {
    color: #4ade80;
}

.dialog-footer .status-text.status-error {
    color: #f06c75;
}

.dialog-footer .connect-btn {
    border: 0.5px solid var(--text-color, #ddd);
    border-radius: 6px;
    background: transparent;
    color: #5b9aff;
    padding: 6px 20px;
    cursor: pointer;
    white-space: nowrap;
}

.dialog-footer .connect-btn:hover:not(:disabled) {
    background: var(--device-list-hover-color, hsl(218, 17%, 18%));
}

.dialog-footer .connect-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}
```

- [ ] **Step 2: Build and verify no errors**

Run: `npm run build:dev`
Expected: Compiles successfully. The old CSS classes are still referenced by the old TS code, but webpack won't error on unused CSS classes. The page will look broken until we rewrite createUI() in Task 2.

- [ ] **Step 3: Commit**

```bash
git add src/style/dialog.css
git commit -m "style: replace dialog.css with glassmorphism modal styles"
```

---

### Task 2: Rewrite createUI() — modal shell and stream settings

**Files:**
- Modify: `src/app/googDevice/client/ConfigureScrcpy.ts:460-641` (createUI method)
- Modify: `src/app/googDevice/client/ConfigureScrcpy.ts:643-651` (removeUI method)
- Modify: `src/app/googDevice/client/ConfigureScrcpy.ts:30-52` (class fields)

This replaces the `createUI()` method with the new modal structure: centered container, X close button, stream settings grid, advanced toggle with animated reveal, settings buttons, and footer with colored status + connect button. Also updates `removeUI()` for the new structure and removes unused class fields.

- [ ] **Step 1: Update class fields**

Replace lines 31-52 (the private field declarations) with:

```typescript
    private readonly TAG: string;
    private readonly udid: string;
    private readonly escapedUdid: string;
    private readonly playerStorageKey: string;
    private deviceName: string;
    private playerName?: string;
    private videoCodecSelect?: HTMLSelectElement;
    private audioCodecSelect?: HTMLSelectElement;
    private displayInfo?: DisplayInfo;
    private background: HTMLElement;
    private dialogBody?: HTMLElement;
    private connectButton?: HTMLButtonElement;
    private fitToScreenCheckbox?: HTMLInputElement;
    private resetSettingsButton?: HTMLButtonElement;
    private loadSettingsButton?: HTMLButtonElement;
    private saveSettingsButton?: HTMLButtonElement;
    private playerSelectElement?: HTMLSelectElement;
    private displayIdSelectElement?: HTMLSelectElement;
    private encoderSelectElement?: HTMLSelectElement;
    private statusElement?: HTMLElement;
    private dialogContainer?: HTMLElement;
    private advancedSection?: HTMLElement;
    private advancedChevron?: HTMLElement;
    private statusText = '';
```

Note: `okButton` renamed to `connectButton`, `connectionStatusElement` renamed to `statusElement`, added `advancedSection` and `advancedChevron`.

- [ ] **Step 2: Update all references to renamed fields**

In `onProbeResult()` (around line 172-180), replace:
```typescript
        if (this.okButton) {
            this.okButton.disabled = false;
        }
```
with:
```typescript
        if (this.connectButton) {
            this.connectButton.disabled = false;
        }
```

In `updateStatus()` (around line 244-249), replace:
```typescript
    private updateStatus(): void {
        if (!this.connectionStatusElement) {
            return;
        }
        this.connectionStatusElement.innerText = this.statusText;
    }
```
with:
```typescript
    private updateStatus(): void {
        if (!this.statusElement) {
            return;
        }
        this.statusElement.textContent = this.statusText;
        this.statusElement.className = 'status-text';
        if (this.statusText.toLowerCase().startsWith('probing')) {
            this.statusElement.classList.add('status-probing');
        } else if (this.statusText.toLowerCase() === 'ready') {
            this.statusElement.classList.add('status-ready');
        } else if (this.statusText.toLowerCase().startsWith('probe failed')) {
            this.statusElement.classList.add('status-error');
        }
    }
```

In `setStatus()` (around line 239), lowercase the text:
```typescript
    private setStatus(text: string): void {
        this.statusText = text.toLowerCase();
        this.updateStatus();
    }
```

- [ ] **Step 3: Rewrite createUI()**

Replace the entire `createUI()` method (lines 460-641) with:

```typescript
    private createUI(): HTMLElement {
        // ── Backdrop ──
        const background = document.createElement('div');
        background.classList.add('dialog-background');

        // ── Modal container ──
        const container = (this.dialogContainer = document.createElement('div'));
        container.classList.add('dialog-container');

        // ── Header ──
        const header = document.createElement('div');
        header.classList.add('dialog-header');
        const title = document.createElement('span');
        title.classList.add('dialog-title');
        title.textContent = this.deviceName;
        header.appendChild(title);
        const closeBtn = document.createElement('button');
        closeBtn.classList.add('close-btn');
        closeBtn.textContent = '\u00d7'; // × character
        closeBtn.addEventListener('click', this.cancel);
        header.appendChild(closeBtn);

        // ── Body (scrollable) ──
        const body = (this.dialogBody = document.createElement('div'));
        body.classList.add('dialog-body');

        // ── Stream settings grid ──
        const grid = document.createElement('div');
        grid.classList.add('dialog-controls');

        // Player dropdown
        const playerLabel = document.createElement('label');
        playerLabel.classList.add('label');
        playerLabel.textContent = 'player:';
        grid.appendChild(playerLabel);
        const playerSelect = (this.playerSelectElement = document.createElement('select'));
        playerSelect.classList.add('input');
        playerSelect.id = playerLabel.htmlFor = `player_${this.escapedUdid}`;
        grid.appendChild(playerSelect);
        const previouslyUsedPlayer = this.getPreviouslyUsedPlayer();
        StreamClientScrcpy.getPlayers().forEach((playerClass, index) => {
            const { playerFullName } = playerClass;
            const opt = document.createElement('option');
            opt.value = playerFullName;
            opt.textContent = playerFullName;
            playerSelect.appendChild(opt);
            if (playerFullName === previouslyUsedPlayer) {
                playerSelect.selectedIndex = index;
            }
        });
        playerSelect.onchange = this.onPlayerChange;
        this.updateVideoSettingsForPlayer();

        // Display dropdown
        const displayLabel = document.createElement('label');
        displayLabel.classList.add('label');
        displayLabel.textContent = 'display:';
        grid.appendChild(displayLabel);
        if (!this.displayIdSelectElement) {
            this.displayIdSelectElement = document.createElement('select');
        }
        this.displayIdSelectElement.classList.add('input');
        this.displayIdSelectElement.id = displayLabel.htmlFor = `displayId_${this.escapedUdid}`;
        this.displayIdSelectElement.onchange = this.onDisplayIdChange;
        grid.appendChild(this.displayIdSelectElement);

        // Video codec dropdown
        const videoCodecLabel = document.createElement('label');
        videoCodecLabel.classList.add('label');
        videoCodecLabel.textContent = 'video codec:';
        grid.appendChild(videoCodecLabel);
        const videoCodecSelect = (this.videoCodecSelect = document.createElement('select'));
        videoCodecSelect.classList.add('input');
        videoCodecSelect.id = videoCodecLabel.htmlFor = `videoCodec_${this.escapedUdid}`;
        grid.appendChild(videoCodecSelect);

        // Audio codec dropdown
        const audioCodecLabel = document.createElement('label');
        audioCodecLabel.classList.add('label');
        audioCodecLabel.textContent = 'audio codec:';
        grid.appendChild(audioCodecLabel);
        const audioCodecSelect = (this.audioCodecSelect = document.createElement('select'));
        audioCodecSelect.classList.add('input');
        audioCodecSelect.id = audioCodecLabel.htmlFor = `audioCodec_${this.escapedUdid}`;
        grid.appendChild(audioCodecSelect);

        // Encoder dropdown
        const encoderLabel = document.createElement('label');
        encoderLabel.classList.add('label');
        encoderLabel.textContent = 'encoder:';
        grid.appendChild(encoderLabel);
        if (!this.encoderSelectElement) {
            this.encoderSelectElement = document.createElement('select');
        }
        this.encoderSelectElement.classList.add('input');
        this.encoderSelectElement.id = encoderLabel.htmlFor = `encoderName_${this.escapedUdid}`;
        grid.appendChild(this.encoderSelectElement);

        // Bitrate slider
        this.appendBasicInput(grid, {
            label: 'bitrate',
            id: 'bitrate',
            range: { min: 524288, max: 8388608, step: 524288, formatter: Util.prettyBytes },
        });

        // Max FPS slider
        this.appendBasicInput(grid, {
            label: 'max fps',
            id: 'maxFps',
            range: { min: 1, max: 60, step: 1 },
        });

        // ── Advanced separator + toggle ──
        const separator = document.createElement('div');
        separator.classList.add('advanced-separator');
        grid.appendChild(separator);

        const advancedToggle = document.createElement('button');
        advancedToggle.classList.add('advanced-toggle');
        advancedToggle.type = 'button';
        const toggleText = document.createElement('span');
        toggleText.textContent = 'advanced';
        advancedToggle.appendChild(toggleText);
        const chevron = (this.advancedChevron = document.createElement('span'));
        chevron.classList.add('chevron');
        chevron.textContent = '\u25bc'; // ▼ character
        advancedToggle.appendChild(chevron);
        advancedToggle.addEventListener('click', this.toggleAdvanced);
        grid.appendChild(advancedToggle);

        // ── Advanced section (collapsed) ──
        const advanced = (this.advancedSection = document.createElement('div'));
        advanced.classList.add('advanced-section');

        // I-Frame interval
        this.appendBasicInput(advanced, { label: 'i-frame interval', id: 'iFrameInterval' });

        // Fit to screen toggle
        const fitLabel = document.createElement('label');
        fitLabel.classList.add('label');
        fitLabel.textContent = 'fit to screen:';
        advanced.appendChild(fitLabel);
        const fitToggle = new ToolBoxCheckbox(
            'fit to screen',
            { off: SvgImage.Icon.TOGGLE_OFF, on: SvgImage.Icon.TOGGLE_ON },
            'fit_to_screen',
        );
        const fitWrapper = document.createElement('div');
        fitWrapper.classList.add('fit-toggle-wrapper');
        fitToggle.getAllElements().forEach((el) => {
            fitWrapper.appendChild(el);
            if (el instanceof HTMLLabelElement) {
                fitLabel.htmlFor = el.htmlFor;
            }
            if (el instanceof HTMLInputElement) {
                this.fitToScreenCheckbox = el;
            }
        });
        advanced.appendChild(fitWrapper);
        fitToggle.addEventListener('click', (_, el) => {
            const element = el.getElement();
            this.onFitToScreenChanged(element.checked);
        });

        // Max width/height
        this.appendBasicInput(advanced, { label: 'max width', id: 'maxWidth' });
        this.appendBasicInput(advanced, { label: 'max height', id: 'maxHeight' });

        // Codec options
        this.appendBasicInput(advanced, { label: 'codec options', id: 'codecOptions' });

        grid.appendChild(advanced);
        body.appendChild(grid);

        // ── Settings buttons ──
        const settingsRow = document.createElement('div');
        settingsRow.classList.add('dialog-settings');

        const resetBtn = (this.resetSettingsButton = document.createElement('button'));
        resetBtn.textContent = 'reset';
        resetBtn.addEventListener('click', this.resetSettings);
        settingsRow.appendChild(resetBtn);

        const loadBtn = (this.loadSettingsButton = document.createElement('button'));
        loadBtn.textContent = 'load';
        loadBtn.addEventListener('click', this.loadSettings);
        settingsRow.appendChild(loadBtn);

        const saveBtn = (this.saveSettingsButton = document.createElement('button'));
        saveBtn.textContent = 'save';
        saveBtn.addEventListener('click', this.saveSettings);
        settingsRow.appendChild(saveBtn);

        body.appendChild(settingsRow);

        // ── Footer ──
        const footer = document.createElement('div');
        footer.classList.add('dialog-footer');
        const statusEl = (this.statusElement = document.createElement('span'));
        statusEl.classList.add('status-text');
        footer.appendChild(statusEl);
        this.statusText = 'probing...';
        this.updateStatus();

        const connectBtn = (this.connectButton = document.createElement('button'));
        connectBtn.classList.add('connect-btn');
        connectBtn.textContent = 'connect';
        connectBtn.disabled = true;
        connectBtn.addEventListener('click', this.openStream);
        footer.appendChild(connectBtn);

        // ── Assemble ──
        container.appendChild(header);
        container.appendChild(body);
        container.appendChild(footer);
        background.appendChild(container);
        background.addEventListener('click', this.onBackgroundClick);
        document.addEventListener('keydown', this.onEscapeKey);
        document.body.appendChild(background);
        return background;
    }
```

- [ ] **Step 4: Add the toggleAdvanced and onEscapeKey methods**

Add these new methods after the `onBackgroundClick` method (around line 658):

```typescript
    private toggleAdvanced = (): void => {
        if (!this.advancedSection || !this.advancedChevron) return;
        const isExpanded = this.advancedSection.classList.toggle('expanded');
        this.advancedChevron.classList.toggle('expanded', isExpanded);
    };

    private onEscapeKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            this.cancel();
        }
    };
```

- [ ] **Step 5: Update removeUI()**

Replace the `removeUI()` method with:

```typescript
    private removeUI(): void {
        document.body.removeChild(this.background);
        this.connectButton?.removeEventListener('click', this.openStream);
        this.resetSettingsButton?.removeEventListener('click', this.resetSettings);
        this.loadSettingsButton?.removeEventListener('click', this.loadSettings);
        this.saveSettingsButton?.removeEventListener('click', this.saveSettings);
        this.background.removeEventListener('click', this.onBackgroundClick);
        document.removeEventListener('keydown', this.onEscapeKey);
    }
```

- [ ] **Step 6: Update openStream() to use connectButton**

In the `openStream` method (around line 685), no changes needed — it references `this.playerName`, `this.videoCodecSelect`, etc. which are still the same fields. Verify no references to `okButton` remain.

- [ ] **Step 7: Remove unused imports**

Remove the `ToolBoxButton` import (line 11) since we no longer use the back button:

```typescript
// DELETE this line:
import { ToolBoxButton } from '../../toolbox/ToolBoxButton';
```

The `Attribute` import (line 5) is still used by `onFitToScreenChanged`. `SvgImage` (line 14) is still used by the fit-to-screen toggle. `ToolBoxCheckbox` (line 12) is still used for the fit-to-screen toggle.

- [ ] **Step 8: Remove the onProbeResult dialogBody show/hide logic**

In `onProbeResult()` (around line 177-180), remove:
```typescript
        if (this.dialogBody) {
            this.dialogBody.classList.remove('hidden');
            this.dialogBody.classList.add('visible');
        }
```

The new modal doesn't hide the body — it's always visible. The dropdowns start empty and populate when the probe returns. Also remove the `ready` class toggle:
```typescript
        this.dialogContainer?.classList.add('ready');
```

- [ ] **Step 9: Build and verify**

Run: `npm run build:dev`
Expected: Compiles successfully with no errors.

- [ ] **Step 10: Restart server and test in browser**

Kill the running server, start it fresh:
```bash
# Find PID and kill, then:
node dist/index.js &
```

Open http://localhost:8000, click "configure stream" on a device card. Verify:
- Modal appears centered with glass effect and blurred backdrop
- X button closes the modal
- Backdrop click closes the modal
- Escape key closes the modal
- Dropdowns populate after probe ("probing..." → "ready" with colors)
- Advanced section expands/collapses with animation
- Settings buttons (reset, load, save) visible and styled
- "connect" button enables after probe
- Clicking "connect" starts a stream

- [ ] **Step 11: Commit**

```bash
git add src/app/googDevice/client/ConfigureScrcpy.ts
git commit -m "feat: rewrite configure stream as centered glassmorphism modal

Centered overlay with backdrop blur, X to close, Escape key dismiss.
Stream settings visible by default, advanced fields behind animated
reveal. Settings buttons restyled. Status text colored (red probing,
green ready). Connect button replaces Open. All text lowercase except
device name."
```

---

### Task 3: Visual polish and edge cases

**Files:**
- Modify: `src/style/dialog.css` (tweaks if needed)
- Modify: `src/app/googDevice/client/ConfigureScrcpy.ts` (save button flash)

- [ ] **Step 1: Add save confirmation flash**

In the `saveSettings` method, add a brief "saved" text flash:

```typescript
    private saveSettings = (): void => {
        const videoSettings = this.buildVideoSettings();
        const player = this.getPlayer();
        if (videoSettings && player) {
            const fitToScreen = this.getFitToScreenValue();
            player.saveVideoSettings(this.udid, videoSettings, fitToScreen, this.displayInfo);
        }
        if (this.saveSettingsButton) {
            const original = this.saveSettingsButton.textContent;
            this.saveSettingsButton.textContent = 'saved';
            setTimeout(() => {
                if (this.saveSettingsButton) {
                    this.saveSettingsButton.textContent = original;
                }
            }, 1500);
        }
    };
```

- [ ] **Step 2: Build, restart, verify the save flash**

Run: `npm run build:dev`
Restart server. Open configure stream, click "save" — verify text briefly shows "saved" then returns to "save".

- [ ] **Step 3: Run test suite**

Run: `npm test`
Expected: All 46 tests passing. No test changes needed — ConfigureScrcpy has no unit tests (it's pure DOM UI).

- [ ] **Step 4: Commit**

```bash
git add src/app/googDevice/client/ConfigureScrcpy.ts
git commit -m "fix: add save confirmation flash on configure stream modal"
```

---

### Task 4: Push and update docs

**Files:**
- Modify: `docs/TECHNICAL_GUIDE.md`

- [ ] **Step 1: Update technical guide**

In the TECHNICAL_GUIDE.md, update references to the configure stream dialog. Section 14.1 mentions the configure stream button under "opens in overlay". No structural change needed since we already updated that in the earlier commit. But add a brief note in the section that mentions the dialog:

Find the line referencing `configure stream` in section 14.1 and ensure it says "opens a centered modal overlay" not "flyout" or "dialog".

Also update section 5 if it mentions the dialog layout (check first).

- [ ] **Step 2: Push all commits**

```bash
git push
```

- [ ] **Step 3: Verify clean state**

```bash
git status
git log --oneline -5
```

Expected: Clean working tree, up to date with remote.
