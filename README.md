# ws-scrcpy-web

Browser-based Android screen mirroring and control, powered by [scrcpy](https://github.com/Genymobile/scrcpy).

A modernized spiritual successor to [ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy), rebuilt with a focus on maintainability, modern tooling, and staying current with scrcpy releases.

## Key Design Decisions

- **Vanilla scrcpy-server** -- uses unmodified Genymobile scrcpy-server binaries. No Java patching, no custom forks. Drop in new versions as they release.
- **Node.js ADB proxy** -- the server bridges ADB tunnels to WebSocket connections for the browser. The protocol layer is implemented in TypeScript.
- **Modern stack** -- TypeScript 5, current Node.js, up-to-date dependencies.
- **Focused feature set** -- screen mirroring, touch/keyboard control, ADB shell, file management. No iOS support, no Chrome DevTools proxy.

## Features

- Real-time screen mirroring in the browser via WebSocket
- Touch and keyboard input forwarding
- Multiple video decoder support (WebCodecs, Broadway, TinyH264, MSE)
- Remote ADB shell terminal
- File manager (browse, upload, download, APK install)
- Audio forwarding (planned)

## Requirements

- **Node.js** 18+
- **ADB** installed and in PATH
- **Android device** with USB debugging enabled (or wireless ADB)

## Quick Start

```bash
npm install
npm start
```

Open `http://localhost:8000` in your browser.

## Acknowledgments

This project is based on [ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy) by [Sergey Volkov](https://github.com/nicedayzhu) / Netris, JSC. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for full license details.

Screen mirroring powered by [scrcpy](https://github.com/Genymobile/scrcpy) by [Genymobile](https://github.com/Genymobile) / [Romain Vimont](https://github.com/rom1v).

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
