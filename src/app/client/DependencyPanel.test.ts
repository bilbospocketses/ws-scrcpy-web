// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { type DependencyInfo, DependencyStatus } from '../../common/DependencyTypes';
import { DependencyPanel } from './DependencyPanel';

const dep = (o: Partial<DependencyInfo>): DependencyInfo => ({
    name: 'adb',
    displayName: 'ADB',
    installedVersion: null,
    latestVersion: null,
    status: DependencyStatus.Error,
    description: 'desc',
    requiresRestart: false,
    canUpdate: false,
    ...o,
});

describe('DependencyPanel XSS', () => {
    it('escapes a malicious displayName/description instead of injecting markup', () => {
        const panel = new DependencyPanel();
        (panel as any).render([
            dep({ displayName: '<img src=x onerror=alert(1)>', description: '<svg onload=alert(2)>' }),
        ]);
        const body = panel.getElement().querySelector('tbody');
        expect(body?.querySelector('img')).toBeNull();
        expect(body?.querySelector('svg')).toBeNull();
        expect(body?.textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('escapes a malicious errorMessage in the status title attribute', () => {
        const panel = new DependencyPanel();
        (panel as any).render([
            dep({ status: DependencyStatus.Error, errorMessage: 'x"><img src=y onerror=alert(1)>' }),
        ]);
        const body = panel.getElement().querySelector('tbody');
        expect(body?.querySelector('img')).toBeNull();
    });
});
