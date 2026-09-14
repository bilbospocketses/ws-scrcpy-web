/** One staged edit, exactly as the summary renders it and the batch applies it. */
export interface Change {
    id: string;
    label: string;
    from: unknown;
    to: unknown;
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

    changes(): Change[] {
        const out: Change[] = [];
        for (const [id, field] of this.fields) {
            const current = this.values.get(id);
            if (Object.is(current, field.initial)) continue;
            const render = field.format ?? ((v: unknown): unknown => v);
            out.push({ id, label: field.label, from: render(field.initial), to: render(current) });
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
