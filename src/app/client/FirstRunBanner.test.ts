// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { type DependencyInfo, DependencyStatus } from '../../common/DependencyTypes';
import { FirstRunBanner } from './FirstRunBanner';

const dep = (displayName: string): DependencyInfo => ({
    name: 'x',
    displayName,
    installedVersion: null,
    latestVersion: null,
    status: DependencyStatus.Error,
    description: '',
    requiresRestart: false,
    canUpdate: false,
});

describe('FirstRunBanner XSS', () => {
    it('escapes a malicious dependency displayName instead of injecting markup', () => {
        const banner = new FirstRunBanner();
        (banner as any).render([dep('<img src=x onerror=alert(1)>')]);
        const el = banner.getElement();
        expect(el.querySelector('img')).toBeNull();
        expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    });
});
