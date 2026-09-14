/**
 * One staged edit: the RAW values the batch applies, plus optional display text
 * for the summary to render.
 *
 * `from`/`to` are the values as the field holds them and as the server must
 * receive them -- never formatted. They used to carry the `format`ted string
 * instead, which made `autoUpdate` unsavable: the store emitted `to: 'off'`,
 * `SettingsBatchApi` passed that straight to `updateAppConfig`, and
 * `validateField` refused it because `autoUpdate must be a boolean`. Every
 * toggle-and-Save 400'd, with the WAL row marked `failed`.
 *
 * Display text therefore rides ALONGSIDE the value rather than replacing it.
 * The extra fields are inert on the wire and in the WAL -- the server reads only
 * `id` and `to` -- and being optional they cost nothing for the fields (every
 * one but `autoUpdate`) that have no formatter.
 */
export interface Change {
    id: string;
    label: string;
    from: unknown;
    to: unknown;
    /** `format(from)` when the field has a formatter; absent otherwise. */
    fromText?: string;
    /** `format(to)` when the field has a formatter; absent otherwise. */
    toText?: string;
}

export interface StagedField {
    id: string;
    label: string;
    initial: unknown;
    /** Render a value for the summary — e.g. true -> "on". Identity when absent. */
    format?(v: unknown): string;
}

/**
 * Dirty state and the change list for the Settings dialog. No DOM, no network.
 *
 * The critical property is what it does NOT do: a field nobody registered can
 * never appear in `changes()`. Action-only tabs (Service, Users, Embedding)
 * register nothing, so "actions must not appear in the summary" is structural
 * rather than a rule someone has to remember -- and a future action cannot leak
 * into the summary by oversight.
 */
export class StagedSettingsStore {
    private fields = new Map<string, StagedField>();
    private values = new Map<string, unknown>();
    private listeners = new Set<() => void>();

    /**
     * Run `listener` after every mutation; returns an unsubscribe.
     *
     * Added for the dialog-level Save button, which is enabled exactly when
     * `isDirty()`. There is no DOM event that reliably means "something was
     * staged": the Updates check-interval field commits from a 500ms DEBOUNCE
     * timer, so its `input` event fires half a second before the value reaches
     * this store, and the commit itself fires no event at all. A modal
     * inferring dirtiness from events therefore leaves Save greyed out over a
     * real staged change until the user happens to click something else.
     *
     * Deliberately a bare "something changed" signal with no payload: every
     * consumer re-reads `isDirty()` / `changes()`, so this cannot drift out of
     * agreement with what a save would actually send.
     */
    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private notify(): void {
        for (const listener of this.listeners) listener();
    }

    register(field: StagedField): void {
        this.fields.set(field.id, field);
        this.values.set(field.id, field.initial);
        // Registering MOVES the baseline (the tabs re-register from their
        // refreshes), so it can change `isDirty()` just as much as `set` does.
        this.notify();
    }

    set(id: string, value: unknown): void {
        // Silently ignored for an unregistered id: see the class comment.
        if (!this.fields.has(id)) return;
        this.values.set(id, value);
        this.notify();
    }

    get(id: string): unknown {
        return this.values.get(id);
    }

    isDirty(): boolean {
        return this.changes().length > 0;
    }

    /**
     * The staged edits, RAW. `from`/`to` are always the values themselves.
     *
     * A formatter adds `fromText`/`toText` for the summary to render; it never
     * replaces the value. Formatting the value here is what broke `autoUpdate`
     * -- see the `Change` doc comment. The store's job is state, and a value
     * that cannot round-trip to the server is not state.
     */
    changes(): Change[] {
        const out: Change[] = [];
        for (const [id, field] of this.fields) {
            const current = this.values.get(id);
            if (Object.is(current, field.initial)) continue;
            const change: Change = { id, label: field.label, from: field.initial, to: current };
            if (field.format) {
                change.fromText = field.format(field.initial);
                change.toText = field.format(current);
            }
            out.push(change);
        }
        return out;
    }

    reset(): void {
        for (const [id, field] of this.fields) this.values.set(id, field.initial);
        this.notify();
    }

    /**
     * Adopt the current values as the new baseline — what was staged is saved.
     *
     * The opposite of `reset()`, and the counterpart every successful save
     * needs: after the batch lands, those values ARE the settings, so continuing
     * to report them as staged is simply wrong. It is what stops the restart
     * countdown from prompting "unsaved changes" about a batch the server has
     * already applied.
     *
     * Note this re-baselines EVERY registered field to whatever it currently
     * holds, not just the ones in a particular batch — correct here because a
     * save always sends the whole change list, so nothing staged is left behind.
     */
    commit(): void {
        for (const [id, field] of this.fields) {
            this.fields.set(id, { ...field, initial: this.values.get(id) });
        }
        this.notify();
    }

    clear(): void {
        this.fields.clear();
        this.values.clear();
        this.notify();
    }
}
