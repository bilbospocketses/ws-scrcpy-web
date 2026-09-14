import type { Role } from '../../AuthClient';
import { ConfirmModal } from '../../ConfirmModal';
import type { StagedSettingsStore } from '../StagedSettingsStore';

/**
 * What every tab builder gets, regardless of whether it uses it.
 *
 * Deliberately does NOT carry `docker` or `adminReachable`. Both are known only
 * *after* the `/api/config` probe resolves (`SettingsModal.ts` sets them once
 * `probeRuntime()` answers), whereas every tab is built eagerly during
 * `fillBody`, which runs before that probe settles (`TabStrip` builds all tab
 * bodies synchronously in its constructor). A snapshot taken here would be
 * permanently wrong. Docker gating is handled post-probe by
 * `SettingsModal.applyDockerGating()`, which swaps a tab's whole body via
 * `TabStrip.replaceTabBody()` — no tab needs to know about it itself. If a
 * future tab genuinely needs live probe state, pass an accessor
 * (`isDocker(): boolean`), never a boolean captured at build time.
 */
export interface TabContext {
    role: Role | null;
    authEnabled: boolean;
    reload(): void;
}

/**
 * Build a section shell. Returns { section, body } — body is the grid
 * container into which rows go.
 *
 * A local copy, duplicated here and in every other extracted tab rather than
 * shared. There is nothing left to share it WITH: Task 9 moved the last section
 * (Updates) out of `SettingsModal.ts` and deleted the private `buildSection` /
 * `buildRow` / `buildDynamicLabelRow` these were copied from, so the modal now
 * owns no section of its own. No shared layout module is part of this move
 * either — one small duplicated helper per tab is what the plan sanctions.
 * Introducing one is a deliberate change, not a tidy-up.
 */
function buildSection(title: string): { section: HTMLElement; body: HTMLElement } {
    const section = document.createElement('section');
    section.className = 'settings-section';
    const heading = document.createElement('h3');
    heading.className = 'settings-section-heading';
    heading.textContent = title;
    section.appendChild(heading);
    const body = document.createElement('div');
    body.className = 'settings-section-body';
    section.appendChild(body);
    return { section, body };
}

/**
 * Build a single grid row: description label on the left, control(s) on the
 * right. See `buildSection` for why this is a local copy.
 */
function buildRow(labelText: string, control: HTMLElement | DocumentFragment): HTMLElement {
    const row = document.createElement('div');
    row.className = 'settings-row';

    const label = document.createElement('span');
    label.className = 'settings-label';
    label.textContent = labelText;
    row.appendChild(label);

    const controlWrap = document.createElement('div');
    controlWrap.className = 'settings-control';
    controlWrap.appendChild(control);
    row.appendChild(controlWrap);

    return row;
}

/**
 * The Embedding tab (admin-only) — origins allowed to frame this app, each
 * with a revoke button.
 *
 * Permission is granted through the consent prompt, which is a one-way door
 * without this — approving wrote an origin into config.json and there was no
 * way back short of hand-editing the file. Revoking takes effect on the
 * running server immediately.
 *
 * Registers nothing with `store`: revoking an origin is an action (an
 * immediate POST), not a value that can be staged and saved later.
 */
export function buildEmbeddingTab(_ctx: TabContext, _store: StagedSettingsStore): HTMLElement {
    const { section, body } = buildSection('Embedding');
    renderEmbedOrigins(body, null);
    void refreshEmbedOrigins(body);
    return section;
}

async function refreshEmbedOrigins(body: HTMLElement): Promise<void> {
    try {
        const res = await fetch('/api/embed-origins', { headers: { Accept: 'application/json' } });
        if (!res.ok) {
            renderEmbedOrigins(body, [], 'could not read the list — see server logs.');
            return;
        }
        const data = (await res.json()) as { origins?: string[] };
        renderEmbedOrigins(body, data.origins ?? []);
    } catch {
        renderEmbedOrigins(body, [], 'could not reach the server.');
    }
}

/** `origins === null` means "still loading". */
function renderEmbedOrigins(body: HTMLElement, origins: string[] | null, error?: string): void {
    body.textContent = '';

    if (error) {
        body.appendChild(buildRow(error, document.createElement('span')));
        return;
    }
    if (origins === null) {
        body.appendChild(buildRow('loading…', document.createElement('span')));
        return;
    }
    if (origins.length === 0) {
        body.appendChild(buildRow('No other origins may embed this app.', document.createElement('span')));
        return;
    }

    for (const origin of origins) {
        const revokeBtn = document.createElement('button');
        revokeBtn.type = 'button';
        revokeBtn.className = 'modal-button';
        revokeBtn.textContent = 'revoke';
        revokeBtn.addEventListener('click', () => {
            void (async () => {
                // Confirm first: revoking silently breaks a working embed in the other app,
                // and the browser reports that as "refused to connect" — easy to misread as
                // the server being down.
                const sure = await ConfirmModal.confirm({
                    title: 'revoke embedding permission?',
                    message:
                        `${origin} will no longer be able to display this app in a frame. ` +
                        'Anything it is currently showing will stop working immediately. ' +
                        'It can ask again.',
                });
                if (!sure) return;

                revokeBtn.disabled = true;
                try {
                    const res = await fetch('/api/embed-origins/revoke', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ origin }),
                    });
                    if (res.ok) {
                        const updated = (await res.json()) as { origins?: string[] };
                        renderEmbedOrigins(body, updated.origins ?? []);
                    } else {
                        // Most likely a stale list — re-read rather than guess.
                        await refreshEmbedOrigins(body);
                    }
                } catch {
                    renderEmbedOrigins(body, [], 'could not reach the server.');
                }
            })();
        });
        body.appendChild(buildRow(origin, revokeBtn));
    }
}
