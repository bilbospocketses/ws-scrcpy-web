# ListFilesModal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the full-page new-tab file manager with a modern file browser inside a native `<dialog>` modal — complete with breadcrumb navigation, sortable columns, selection, bulk operations, SVG icons, configurable icon sizes, drag-and-drop upload, download progress, and delete with confirmation.

**Architecture:** `ListFilesModal extends Modal` orchestrates the UI. Reuses the existing WebSocket-based file protocol (LIST/RECV/SEND/STAT) from `FileListingClient` — extract the protocol logic into a shared service, build new DOM in the modal. New REST endpoint for delete. SVG icons via a `FileIconUtils` utility. Icon size preference via CSS custom properties + localStorage.

**Tech Stack:** TypeScript 6.x, native `<dialog>` API, CSS custom properties, inline SVGs, Vitest, webpack 5

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/app/googDevice/client/ListFilesModal.ts` | Modal subclass — file browser UI, selection state, sort/filter, transfer management |
| Create | `src/app/googDevice/client/FileIconUtils.ts` | SVG icon registry, extension → icon type mapping, `getFileIcon(filename)` |
| Create | `src/style/listfiles.css` | File browser styles: rows, breadcrumbs, progress bars, drop zone, size picker |
| Create | `src/app/googDevice/client/__tests__/fileIconUtils.test.ts` | Unit tests for icon mapping |
| Modify | `src/style/modal.css` | Add `dialog.list-files-modal` sizing rules |
| Modify | `src/app/googDevice/client/DeviceTracker.ts` | Intercept "list files" link → ListFilesModal |
| Modify | `src/server/api/DeviceDiscoveryApi.ts` | Add `POST /api/devices/files/delete` endpoint |
| Keep | `src/app/googDevice/client/FileListingClient.ts` | Existing protocol logic — ListFilesModal reuses its connection/protocol patterns |
| Delete | `src/style/filelisting.css` | Replaced by `listfiles.css` after conversion |

---

### Task 1: Create FileIconUtils — SVG icons and extension mapping

**Files:**
- Create: `src/app/googDevice/client/FileIconUtils.ts`
- Create: `src/app/googDevice/client/__tests__/fileIconUtils.test.ts`

- [ ] **Step 1: Create the FileIconUtils module**

```typescript
// src/app/googDevice/client/FileIconUtils.ts

export type FileIconType = 'folder' | 'file' | 'image' | 'video' | 'audio' | 'text';

const EXTENSION_MAP: Record<string, FileIconType> = {
    // Image
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', bmp: 'image', webp: 'image', svg: 'image',
    // Video
    mp4: 'video', mkv: 'video', avi: 'video', mov: 'video', webm: 'video', '3gp': 'video',
    // Audio
    mp3: 'audio', ogg: 'audio', flac: 'audio', aac: 'audio', wav: 'audio', m4a: 'audio', opus: 'audio',
    // Text/code
    txt: 'text', md: 'text', json: 'text', xml: 'text', yaml: 'text', yml: 'text',
    log: 'text', conf: 'text', sh: 'text', py: 'text', js: 'text', ts: 'text',
    html: 'text', css: 'text', csv: 'text',
};

// All SVGs use a 24x24 viewBox and scale to --file-icon-size via CSS width/height
const ICON_SVGS: Record<FileIconType, string> = {
    folder: '<svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"/></svg>',
    image: '<svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>',
    video: '<svg viewBox="0 0 24 24"><path d="M4 6.47L5.76 10H20v8H4V6.47M22 4h-4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4z"/></svg>',
    audio: '<svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>',
    text: '<svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
};

const ICON_COLORS: Record<FileIconType, string> = {
    folder: '#5b9aff',
    file: 'rgba(255,255,255,0.5)',
    image: '#4ade80',
    video: '#f97316',
    audio: '#c084fc',
    text: 'rgba(255,255,255,0.5)',
};

export function getFileIconType(filename: string, isDirectory: boolean, isSymlink: boolean): FileIconType {
    if (isDirectory) return 'folder';
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return EXTENSION_MAP[ext] ?? 'file';
}

export function createFileIcon(type: FileIconType): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.classList.add('file-icon', `file-icon-${type}`);
    wrapper.style.color = ICON_COLORS[type];
    wrapper.innerHTML = ICON_SVGS[type];
    return wrapper;
}

export function createFileIconForEntry(filename: string, isDirectory: boolean, isSymlink: boolean): HTMLElement {
    const type = getFileIconType(filename, isDirectory, isSymlink);
    const icon = createFileIcon(type);
    if (isSymlink) {
        icon.classList.add('file-icon-symlink');
    }
    return icon;
}
```

- [ ] **Step 2: Write unit tests**

```typescript
// src/app/googDevice/client/__tests__/fileIconUtils.test.ts

import { describe, expect, it } from 'vitest';
import { getFileIconType } from '../FileIconUtils';

describe('getFileIconType', () => {
    it('returns folder for directories', () => {
        expect(getFileIconType('DCIM', true, false)).toBe('folder');
    });

    it('returns folder for directory even with file-like name', () => {
        expect(getFileIconType('photos.bak', true, false)).toBe('folder');
    });

    it('returns image for image extensions', () => {
        expect(getFileIconType('photo.jpg', false, false)).toBe('image');
        expect(getFileIconType('icon.PNG', false, false)).toBe('image');
        expect(getFileIconType('graphic.webp', false, false)).toBe('image');
    });

    it('returns video for video extensions', () => {
        expect(getFileIconType('movie.mp4', false, false)).toBe('video');
        expect(getFileIconType('clip.mkv', false, false)).toBe('video');
    });

    it('returns audio for audio extensions', () => {
        expect(getFileIconType('song.mp3', false, false)).toBe('audio');
        expect(getFileIconType('track.flac', false, false)).toBe('audio');
    });

    it('returns text for text/code extensions', () => {
        expect(getFileIconType('readme.txt', false, false)).toBe('text');
        expect(getFileIconType('config.json', false, false)).toBe('text');
        expect(getFileIconType('script.sh', false, false)).toBe('text');
    });

    it('returns file for unknown extensions', () => {
        expect(getFileIconType('data.bin', false, false)).toBe('file');
        expect(getFileIconType('archive.apk', false, false)).toBe('file');
    });

    it('returns file for files with no extension', () => {
        expect(getFileIconType('Makefile', false, false)).toBe('file');
    });

    it('handles case insensitively', () => {
        expect(getFileIconType('Photo.JPG', false, false)).toBe('image');
        expect(getFileIconType('VIDEO.MP4', false, false)).toBe('video');
    });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/app/googDevice/client/__tests__/fileIconUtils.test.ts`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/app/googDevice/client/FileIconUtils.ts src/app/googDevice/client/__tests__/fileIconUtils.test.ts
git commit -m "feat: add FileIconUtils — SVG icons and extension mapping"
```

---

### Task 2: Add delete API endpoint

**Files:**
- Modify: `src/server/api/DeviceDiscoveryApi.ts`

- [ ] **Step 1: Add the delete endpoint**

In `DeviceDiscoveryApi.ts`, find the last `if (req.method === ...` block (the PUT for labels). After it, add:

```typescript
if (req.method === 'POST' && url === '/api/devices/files/delete') {
    const body = await readBody(req);
    const { udid, paths } = JSON.parse(body);
    if (!udid || !Array.isArray(paths) || paths.length === 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'udid and paths[] are required' }));
        return true;
    }
    const errors: { path: string; error: string }[] = [];
    for (const filePath of paths) {
        try {
            // Shell-escape the path to prevent injection
            const escaped = filePath.replace(/'/g, "'\\''");
            await this.adbClient.shell(udid, `rm -rf '${escaped}'`);
        } catch (err) {
            errors.push({ path: filePath, error: (err as Error).message });
        }
    }
    const success = errors.length === 0;
    res.writeHead(success ? 200 : 207);
    res.end(JSON.stringify({ success, errors: errors.length > 0 ? errors : undefined }));
    return true;
}
```

- [ ] **Step 2: Build and verify**

Run: `npm run build`

Expected: Build succeeds.

- [ ] **Step 3: Run tests**

Run: `npm test`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/server/api/DeviceDiscoveryApi.ts
git commit -m "feat: add POST /api/devices/files/delete endpoint"
```

---

### Task 3: Add list-files-modal CSS rules

**Files:**
- Modify: `src/style/modal.css`
- Create: `src/style/listfiles.css`

- [ ] **Step 1: Add modal sizing to modal.css**

Append to the end of `src/style/modal.css`:

```css
/* ── List files modal overrides ── */
dialog.list-files-modal .modal-frame {
    width: clamp(500px, 70vw, 900px);
    max-height: 85vh;
}

dialog.list-files-modal .modal-body {
    padding: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
```

- [ ] **Step 2: Create the listfiles.css stylesheet**

Create `src/style/listfiles.css` with all file browser styles. This is a large file — key sections:

```css
/* ── Icon sizing via CSS custom property ── */
.list-files-modal .file-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
}

.list-files-modal .file-icon svg {
    width: var(--file-icon-size, 24px);
    height: var(--file-icon-size, 24px);
    fill: currentColor;
}

.list-files-modal .file-icon-symlink::after {
    content: '↗';
    position: absolute;
    bottom: -2px;
    left: -2px;
    font-size: 8px;
    line-height: 1;
}

.list-files-modal .file-icon-symlink {
    position: relative;
}

/* ── Breadcrumb bar ── */
.list-files-breadcrumbs {
    display: flex;
    align-items: center;
    padding: 6px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    gap: 4px;
    overflow-x: auto;
    flex-shrink: 0;
}

[data-theme="light"] .list-files-breadcrumbs {
    border-bottom-color: rgba(0, 0, 0, 0.08);
}

.list-files-breadcrumb-segment {
    background: rgba(91, 154, 255, 0.15);
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
    white-space: nowrap;
    font-size: 13px;
}

.list-files-breadcrumb-segment:hover {
    background: rgba(91, 154, 255, 0.3);
}

.list-files-breadcrumb-current {
    padding: 2px 8px;
    white-space: nowrap;
    font-size: 13px;
    opacity: 0.7;
}

.list-files-breadcrumb-separator {
    opacity: 0.3;
    font-size: 13px;
}

.list-files-filter {
    margin-left: auto;
    flex-shrink: 0;
}

.list-files-filter input {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    color: var(--text-color, #ddd);
    padding: 2px 8px;
    font-family: monospace;
    font-size: 12px;
    width: 120px;
}

.list-files-filter input:focus {
    outline: none;
    border-color: #5b9aff;
}

/* ── Column headers ── */
.list-files-header {
    display: flex;
    align-items: center;
    padding: 6px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
    flex-shrink: 0;
    gap: 8px;
}

[data-theme="light"] .list-files-header {
    border-bottom-color: rgba(0, 0, 0, 0.08);
    color: rgba(0, 0, 0, 0.4);
}

.list-files-header-name {
    flex: 1;
    cursor: pointer;
    user-select: none;
}

.list-files-header-size,
.list-files-header-date {
    width: 80px;
    text-align: right;
    cursor: pointer;
    user-select: none;
}

.list-files-header-check {
    width: 16px;
    height: 16px;
    accent-color: #5b9aff;
}

.list-files-sort-arrow {
    font-size: 10px;
    margin-left: 2px;
}

.list-files-header-name:hover,
.list-files-header-size:hover,
.list-files-header-date:hover {
    color: var(--text-color, #ddd);
}

/* ── File list (scrollable) ── */
.list-files-body {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
}

/* ── File row ── */
.list-files-row {
    display: flex;
    align-items: center;
    padding: 4px 12px;
    gap: 8px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.02);
    font-size: 13px;
    position: relative;
}

.list-files-row:hover {
    background: rgba(255, 255, 255, 0.04);
}

.list-files-row.selected {
    background: rgba(91, 154, 255, 0.08);
}

.list-files-row.directory {
    cursor: pointer;
}

.list-files-row-check {
    width: 16px;
    height: 16px;
    accent-color: #5b9aff;
    flex-shrink: 0;
}

.list-files-row-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.list-files-row-size {
    width: 80px;
    text-align: right;
    opacity: 0.4;
    font-size: 11px;
    flex-shrink: 0;
}

.list-files-row-date {
    width: 80px;
    text-align: right;
    opacity: 0.4;
    font-size: 11px;
    flex-shrink: 0;
}

/* ── Hover actions ── */
.list-files-row-actions {
    display: none;
    gap: 4px;
    flex-shrink: 0;
}

.list-files-row:hover .list-files-row-actions {
    display: flex;
}

.list-files-action-btn {
    background: transparent;
    border: none;
    cursor: pointer;
    padding: 2px 4px;
    font-size: 14px;
    border-radius: 3px;
}

.list-files-action-download {
    color: #5b9aff;
}

.list-files-action-download:hover {
    background: rgba(91, 154, 255, 0.15);
}

.list-files-action-delete {
    color: #f06c75;
}

.list-files-action-delete:hover {
    background: rgba(240, 108, 117, 0.15);
}

/* ── Progress bar (in-row) ── */
.list-files-progress {
    position: absolute;
    left: 0;
    top: 0;
    height: 100%;
    background: rgba(91, 154, 255, 0.1);
    transition: width 0.2s ease;
    pointer-events: none;
}

.list-files-progress.error {
    background: rgba(240, 108, 117, 0.15);
}

/* ── Footer ── */
.list-files-footer {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    flex-shrink: 0;
    gap: 8px;
    font-size: 12px;
}

[data-theme="light"] .list-files-footer {
    border-top-color: rgba(0, 0, 0, 0.08);
}

.list-files-footer-actions {
    display: flex;
    gap: 6px;
}

.list-files-footer-btn {
    border: 0.5px solid var(--text-color, #ddd);
    border-radius: 4px;
    background: transparent;
    color: #5b9aff;
    padding: 4px 12px;
    cursor: pointer;
    font-family: monospace;
    font-size: 12px;
}

.list-files-footer-btn:hover:not(:disabled) {
    background: rgba(91, 154, 255, 0.1);
}

.list-files-footer-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
}

.list-files-footer-btn.delete {
    color: #f06c75;
}

.list-files-footer-btn.delete:hover:not(:disabled) {
    background: rgba(240, 108, 117, 0.1);
}

.list-files-footer-info {
    margin-left: auto;
    opacity: 0.5;
}

/* ── Drop zone overlay ── */
.list-files-dropzone {
    position: absolute;
    inset: 0;
    background: rgba(91, 154, 255, 0.1);
    border: 3px dashed #5b9aff;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    color: #5b9aff;
    z-index: 10;
    pointer-events: none;
}

/* ── Size picker ── */
.list-files-size-picker {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
    gap: 16px;
    flex: 1;
}

.list-files-size-picker h3 {
    font-size: 15px;
    font-weight: 600;
    margin: 0;
}

.list-files-size-options {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: center;
}

.list-files-size-option {
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    padding: 12px 16px;
    cursor: pointer;
    text-align: center;
    min-width: 60px;
    transition: border-color 0.15s;
}

.list-files-size-option:hover {
    border-color: rgba(91, 154, 255, 0.5);
}

.list-files-size-option.selected {
    border-color: #5b9aff;
    background: rgba(91, 154, 255, 0.1);
}

.list-files-size-option .size-label {
    font-size: 12px;
    opacity: 0.6;
    margin-top: 4px;
}

.list-files-size-picker-controls {
    display: flex;
    align-items: center;
    gap: 12px;
}

.list-files-size-picker-controls label {
    font-size: 12px;
    opacity: 0.7;
    display: flex;
    align-items: center;
    gap: 4px;
}

.list-files-size-picker-note {
    font-size: 11px;
    opacity: 0.5;
    font-style: italic;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/style/modal.css src/style/listfiles.css
git commit -m "feat: add list-files-modal CSS — file browser styles, size picker, drop zone"
```

---

### Task 4: Create ListFilesModal — core modal shell with size picker

**Files:**
- Create: `src/app/googDevice/client/ListFilesModal.ts`

This is the largest task. The modal needs to:
1. Show size picker on first open (or if no localStorage preference)
2. Build the file browser UI (breadcrumbs, column headers, file list, footer)
3. Connect to the device via the existing multiplexer protocol
4. Handle directory listing, navigation, selection, sorting, filtering
5. Handle downloads, uploads, delete
6. Manage transfer state for dismiss confirmation

Given the size, this task creates the modal shell with the size picker and the basic DOM structure. Subsequent tasks wire up the file protocol, transfers, and entry point.

- [ ] **Step 1: Create the ListFilesModal class**

The modal body starts with either the size picker (no preference) or the file browser (preference exists). Create `src/app/googDevice/client/ListFilesModal.ts` with:

- Constructor: accepts `(udid, deviceLabel, params)`, checks localStorage for icon size preference
- `buildBody()`: empty (populated after super)
- Size picker: shown when no preference, stores selection, calls `showFileBrowser()` on OK
- `showFileBrowser()`: builds breadcrumbs bar, column headers, file list container, footer, then calls `loadDirectory()`
- `loadDirectory(path)`: connects via multiplexer, sends LIST command, parses DENT responses, renders rows
- Row rendering: checkbox, icon (via FileIconUtils), name, size, date, hover actions
- Navigation: click breadcrumb → loadDirectory, click directory row → loadDirectory
- Selection: checkbox state tracking, select-all toggle, footer button state updates
- Sort: click column header → re-sort entries, re-render
- Filter: input → filter visible rows
- Download: single (hover button) and bulk (footer button)
- Upload: footer button + drag-and-drop
- Delete: single (hover button) and bulk (footer button), confirmation, REST API call
- Dismiss hooks: check for active transfers before closing

This is a large file (~600-800 lines). The implementer should read the existing `FileListingClient.ts` thoroughly to understand the protocol patterns (multiplexer channels, STAT/LIST/RECV/SEND commands, DENT/DATA/DONE/FAIL responses) and reuse them.

**Key protocol patterns to reuse from FileListingClient:**
- `getChannelInitData()` — builds the channel init payload with ChannelCode.FSLS + serial
- `loadContent()` — creates a multiplexer channel, sends protocol command (LIST/RECV/STAT), handles responses
- `handleReply()` — parses DENT, DONE, STAT, FAIL, DATA messages
- `addEntry()` — creates Entry objects from DENT responses
- `finishDownload()` — assembles chunks into blob, triggers browser download

**Key differences from FileListingClient:**
- No hash-based navigation — breadcrumbs handle navigation
- No `ManagerClient` base class — extends Modal instead, manages its own WebSocket connection
- DOM is built with standard createElement (not html`` template tag)
- Selection state tracked in a Set<number> (entry indices)
- Sort state tracked as `{ column: 'name'|'size'|'date', ascending: boolean }`
- Filter state tracked as a string
- Transfer tracking: `Map<string, { type: 'upload'|'download', progress: number }>` for dismiss confirmation
- Error rows auto-remove after 10 seconds (not 2 seconds like old code)
- Upload uses same FilePushHandler/AdbkitFilePushStream infrastructure
- Delete calls `POST /api/devices/files/delete` REST endpoint

The implementer should build this incrementally:
1. Modal shell + size picker + basic directory listing (buildBody, loadDirectory, renderEntries)
2. Navigation (breadcrumbs, directory click)
3. Selection (checkboxes, select-all, footer state)
4. Sort and filter
5. Download (single + bulk)
6. Upload (button + drag-and-drop)
7. Delete (single + bulk, confirmation, API call)
8. Dismiss confirmation during active transfers

The complete file is too large to include inline. The implementer has full context from this plan + the spec + the existing FileListingClient.ts code.

- [ ] **Step 2: Build and verify**

Run: `npm run build`

Expected: Build succeeds. ListFilesModal is created but not yet wired to any entry point.

- [ ] **Step 3: Commit**

```bash
git add src/app/googDevice/client/ListFilesModal.ts
git commit -m "feat: add ListFilesModal — modern file browser in native <dialog>"
```

---

### Task 5: Wire DeviceTracker "list files" link to ListFilesModal

**Files:**
- Modify: `src/app/googDevice/client/DeviceTracker.ts`

- [ ] **Step 1: Add import**

```typescript
import { ListFilesModal } from './ListFilesModal';
```

- [ ] **Step 2: Intercept the "list files" link**

The "list files" link is created by `FileListingClient.createEntryForDeviceList()` which adds an `<a>` with class `link-list-files` (from `ACTION.FILE_LISTING = 'list-files'`). Find where DeviceTracker appends tool entries (the `DeviceTracker.tools.forEach` block around line 256-268). After that block, add the intercept — same pattern as shell and connect intercepts:

```typescript
// Intercept list files links — open ListFilesModal instead of navigating to new tab
const listFilesLinks = overlaySection.querySelectorAll('a.link-list-files') as NodeListOf<HTMLAnchorElement>;
listFilesLinks.forEach((link) => {
    link.removeAttribute('target');
    link.addEventListener('click', (e) => {
        e.preventDefault();
        const nameEl = link.closest('.device')?.querySelector('.device-name-text');
        const label = nameEl?.textContent || device['ro.product.model'] || device.udid;
        new ListFilesModal(device.udid, label, this.params);
    });
});
```

Note: Check what `ACTION.FILE_LISTING` evaluates to — it might be `'list-files'` or something else. Verify by checking `src/common/Action.ts`. The link class is `link-${ACTION.FILE_LISTING}`.

- [ ] **Step 3: Build and verify**

Run: `npm run build`

Expected: Build succeeds.

- [ ] **Step 4: Run tests**

Run: `npm test`

Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/app/googDevice/client/DeviceTracker.ts
git commit -m "feat: list files link opens ListFilesModal instead of new tab"
```

---

### Task 6: Delete old filelisting.css

**Files:**
- Delete: `src/style/filelisting.css`

- [ ] **Step 1: Verify no remaining imports of filelisting.css**

Run: `grep -rn "filelisting.css" src/`

The only import should be in `FileListingClient.ts` (line 1). FileListingClient still exists for the embed/URL-based entry path, but since ListFilesModal has its own CSS, we should remove the import from FileListingClient too. Replace it with a comment or remove the line.

- [ ] **Step 2: Remove the import from FileListingClient.ts**

In `src/app/googDevice/client/FileListingClient.ts`, remove line 1:
```typescript
// Remove this line:
import '../../../style/filelisting.css';
```

- [ ] **Step 3: Delete filelisting.css**

Run: `rm src/style/filelisting.css`

- [ ] **Step 4: Build and verify**

Run: `npm run build`

Expected: Build succeeds.

- [ ] **Step 5: Run tests**

Run: `npm test`

Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: delete filelisting.css, replaced by listfiles.css"
```

---

### Task 7: Manual integration test

**Files:** None — manual verification only.

- [ ] **Step 1: Full build from clean state**

Run: `rm -rf dist && npm run build && npm test`

- [ ] **Step 2: Start the server**

Kill any existing process on port 8000, then: `node dist/index.js`

- [ ] **Step 3: Test size picker**

Open `http://localhost:8000`. Click "list files" on a device card.
- [ ] Size picker appears (first open, no localStorage)
- [ ] Five size options visible with sample row previews
- [ ] Clicking a size option highlights it
- [ ] OK button applies the size and shows file listing
- [ ] Close modal, reopen — size picker appears again (preference not saved)
- [ ] Check "save preference", click OK — file listing loads
- [ ] Close modal, reopen — file listing loads immediately (no picker)
- [ ] Click `[⊞]` button in header — size picker reappears
- [ ] Uncheck "save preference", click OK — preference cleared

- [ ] **Step 4: Test navigation**

- [ ] Breadcrumb segments are clickable
- [ ] Clicking a breadcrumb navigates to that directory
- [ ] Clicking a directory row navigates into it
- [ ] Root `/` breadcrumb always present
- [ ] Long paths scroll horizontally in breadcrumb bar

- [ ] **Step 5: Test file list**

- [ ] Files show correct icons (folder, image, video, audio, text, generic)
- [ ] File sizes displayed for files, empty for directories
- [ ] Dates displayed in short format
- [ ] Hover shows download and delete buttons on file rows
- [ ] Hover shows only delete button on directory rows
- [ ] Column headers are clickable — sort toggles ascending/descending
- [ ] Sort arrow indicator shows on active column
- [ ] Directories always sort above files

- [ ] **Step 6: Test selection**

- [ ] Checkbox selects individual files/directories
- [ ] Select-all checkbox in header toggles all
- [ ] Selected rows have blue tint background
- [ ] Footer shows selection count
- [ ] Footer download button disabled when directories selected
- [ ] Footer delete button enabled for any selection
- [ ] Footer upload button always enabled

- [ ] **Step 7: Test filter**

- [ ] Typing in filter input filters file list
- [ ] Filter is case-insensitive
- [ ] Clearing filter restores full list
- [ ] Filter resets when navigating to new directory

- [ ] **Step 8: Test download**

- [ ] Single file download via hover button — progress bar shows, browser downloads
- [ ] Bulk download via footer button — files download sequentially

- [ ] **Step 9: Test upload**

- [ ] Upload button opens file picker
- [ ] Drag files over modal — drop zone overlay appears
- [ ] Drop files — upload progress rows appear at top of list
- [ ] Upload completion refreshes directory listing
- [ ] Upload error shows red row, auto-removes after 10 seconds

- [ ] **Step 10: Test delete**

- [ ] Single file delete via hover button — confirmation dialog
- [ ] Confirm — file deleted, listing refreshes
- [ ] Cancel — nothing happens
- [ ] Bulk delete via footer — confirmation shows count
- [ ] Delete directory — confirmation, deleted
- [ ] Failed delete — 10-second error notification

- [ ] **Step 11: Test dismiss**

- [ ] Escape closes modal (no active transfers)
- [ ] Backdrop click closes modal
- [ ] X button closes modal
- [ ] Start an upload, try to close — confirmation appears
- [ ] Confirm close during transfer — modal closes, transfer aborted
- [ ] Cancel close during transfer — modal stays open

- [ ] **Step 12: Test light theme**

- [ ] Toggle theme — modal styling adapts
- [ ] Breadcrumbs, icons, rows, footer all readable in light mode
