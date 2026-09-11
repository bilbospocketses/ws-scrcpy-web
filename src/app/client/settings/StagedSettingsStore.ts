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

    register(field: StagedField): void {
        this.fields.set(field.id, field);
        this.values.set(field.id, field.initial);
    }

    set(id: string, value: unknown): void {
        // Silently ignored for an unregistered id: see the class comment.
        if (!this.fields.has(id)) return;
        this.values.set(id, value);
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
    }

    clear(): void {
        this.fields.clear();
        this.values.clear();
    }
}
