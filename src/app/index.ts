import '../style/app.css';
import '../style/home.css';
import '../style/dependencies.css';
import { HostTracker } from './client/HostTracker';
import { DependencyPanel } from './client/DependencyPanel';
import { NetworkDiscoveryPanel } from './client/NetworkDiscoveryPanel';
import type { Tool } from './client/Tool';
import { StreamClientScrcpy } from './googDevice/client/StreamClientScrcpy';

window.onload = async (): Promise<void> => {
    const hash = location.hash.replace(/^#!/, '');
    const parsedQuery = new URLSearchParams(hash);
    const action = parsedQuery.get('action');

    if (parsedQuery.get('embed') === 'true') {
        document.body.classList.add('embed');
    }

    const { WebCodecsPlayer } = await import('./player/WebCodecsPlayer');
    StreamClientScrcpy.registerPlayer(WebCodecsPlayer);

    if (action === StreamClientScrcpy.ACTION && typeof parsedQuery.get('udid') === 'string') {
        StreamClientScrcpy.start(parsedQuery);
        return;
    }

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
    // Create page structure in fixed order BEFORE anything renders
    // BaseDeviceTracker will find #devices and use it instead of creating its own
    const devicesDiv = document.createElement('div');
    devicesDiv.id = 'devices';
    devicesDiv.className = 'table-wrapper';
    document.body.appendChild(devicesDiv);

    const discoveryPanel = new NetworkDiscoveryPanel();
    document.body.appendChild(discoveryPanel.getElement());

    DependencyPanel.create().then((depPanel) => {
        document.body.appendChild(depPanel.getElement());
    });

    // Start device tracking — it will populate the #devices div we created above
    HostTracker.start();
};
