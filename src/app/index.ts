import '../style/app.css';
import '../style/dependencies.css';
import '../style/first-run-banner.css';
import '../style/home.css';
import { DependencyPanel } from './client/DependencyPanel';
import { FirstRunBanner } from './client/FirstRunBanner';
import { HostTracker } from './client/HostTracker';
import { NetworkDiscoveryPanel } from './client/NetworkDiscoveryPanel';
import { createSettingsHeader } from './client/SettingsHeader';
import { createThemeToggle, initTheme } from './client/ThemeToggle';
import type { Tool } from './client/Tool';
import { WelcomeModal } from './client/WelcomeModal';
import type { AppConfigEnvelope } from '../common/ConfigEvents';
import { StreamClientScrcpy } from './googDevice/client/StreamClientScrcpy';

function maybeShowWelcomeModal(): void {
    fetch('/api/config')
        .then((r) => (r.ok ? (r.json() as Promise<Partial<AppConfigEnvelope>>) : null))
        .then((data) => {
            const runtime = data?.runtime;
            if (!runtime || runtime.firstRunComplete !== false) return;
            new WelcomeModal({
                webPort: runtime.webPort,
                portWasAutoShifted: runtime.portWasAutoShifted,
                onDecision: () => {
                    // WelcomeModal owns persistence (install or PATCH) for P3+.
                    // Caller may use this to refresh UI state if needed.
                },
            });
        })
        .catch(() => {
            // /api/config absent (e.g., dev server without P2 wiring) — silently bail.
        });
}

// Initialize theme immediately to prevent flash of wrong colors
initTheme();

window.onload = async (): Promise<void> => {
    const hash = location.hash.replace(/^#!/, '');
    const parsedQuery = new URLSearchParams(hash);
    const action = parsedQuery.get('action');

    // WebCodecs player must be registered so ConnectModal can find it
    const { WebCodecsPlayer } = await import('./player/WebCodecsPlayer');
    StreamClientScrcpy.registerPlayer(WebCodecsPlayer);

    const tools: Tool[] = [];

    const { ShellClient } = await import('./googDevice/client/ShellClient');
    if (action === ShellClient.ACTION && typeof parsedQuery.get('udid') === 'string') {
        ShellClient.start(ShellClient.parseParameters(parsedQuery));
        return;
    }
    tools.push(ShellClient);

    const { FileListingClient } = await import('./googDevice/client/FileListingClient');
    if (action === FileListingClient.ACTION) {
        FileListingClient.start(FileListingClient.parseParameters(parsedQuery));
        return;
    }
    tools.push(FileListingClient);

    if (tools.length) {
        const { DeviceTracker } = await import('./googDevice/client/DeviceTracker');
        tools.forEach((tool) => {
            DeviceTracker.registerTool(tool);
        });
    }

    document.body.appendChild(createSettingsHeader());
    document.body.appendChild(createThemeToggle());

    const pageContainer = document.createElement('div');
    pageContainer.className = 'page-container';
    document.body.appendChild(pageContainer);

    FirstRunBanner.create().then((banner) => {
        pageContainer.insertBefore(banner.getElement(), pageContainer.firstChild);
    });

    maybeShowWelcomeModal();

    const devicesDiv = document.createElement('div');
    devicesDiv.id = 'devices';
    devicesDiv.className = 'table-wrapper';
    pageContainer.appendChild(devicesDiv);

    const discoveryPanel = new NetworkDiscoveryPanel();
    pageContainer.appendChild(discoveryPanel.getElement());

    DependencyPanel.create().then((depPanel) => {
        pageContainer.appendChild(depPanel.getElement());
    });

    HostTracker.start();
};
