import type { StagedSettingsStore } from './StagedSettingsStore';

/**
 * What closing the dialog should do.
 *
 * Deliberately a pure function of the store: the decision is testable without a
 * DOM, and the modal only has to act on the answer.
 */
export function closeIntent(store: StagedSettingsStore): 'close' | 'prompt' {
    return store.isDirty() ? 'prompt' : 'close';
}
