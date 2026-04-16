# ws-scrcpy-web

<p align="center">
  <img src="assets/banner.png" alt="ws-scrcpy-web" width="600">
</p>

Browser-based Android screen mirroring and control, powered by [scrcpy](https://github.com/Genymobile/scrcpy).

A modernized spiritual successor to [ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy), rebuilt with a focus on maintainability, modern tooling, and staying current with scrcpy releases.

## Key Design Decisions

- **Vanilla scrcpy-server v3.x** -- uses unmodified Genymobile scrcpy-server binaries. No Java patching, no custom forks. Drop in new versions as they release.
- **Node.js ADB proxy** -- the server bridges ADB tunnels to WebSocket connections for the browser. The protocol layer is implemented in TypeScript.
- **WebCodecs only** -- no WASM decoder fallbacks. Modern browsers only.
- **Pure browser code** -- no Node.js Buffer polyfill or path-browserify in the browser bundle.
- **Focused feature set** -- screen mirroring, touch/keyboard/UHID control, ADB shell, file management. No iOS support, no Chrome DevTools proxy.

## Features

- Real-time screen mirroring in the browser via WebSocket
- **Multi-codec video** -- H.264, H.265 (HEVC), AV1 with automatic detection and smart encoder selection
- **Multi-codec audio** -- Opus, AAC, FLAC, raw PCM via WebCodecs AudioDecoder
- **UHID keyboard/mouse** -- hardware-level input via USB HID reports (pointer lock for mouse)
- Touch and keyboard input forwarding (classic scrcpy keycode mode)
- Configure stream dialog with codec/encoder selection and device probe
- **Redesigned toolbar** -- compact controls with quick stats (FPS, resolution, codec), stream refresh button, and consistent alignment
- **Quality stats overlay** -- real-time FPS, bitrate, resolution, codec, and encoder info
- **Viewport scaling** -- video scales to fill available space with correct aspect ratio
- Remote ADB shell terminal
- File manager (browse, upload, download)
- **Embed mode** -- streamlined iframe integration for embedding in other apps (hides toolbar, auto-scales video, used by [Control Menu](https://github.com/bilbospocketses/control-menu))
- Docker support (Dockerfile included)

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

## Self-Contained Mode

For deployment without system-wide Node.js or ADB installations:

**Windows:**
```batch
start.cmd
```

**Linux:**
```bash
./start.sh
```

The launcher uses Node.js from `dependencies/node/` and ADB from `dependencies/adb/`. Use the Dependencies panel on the home page to check for updates and install them.

### Initial Setup

1. Download Node.js LTS from [nodejs.org](https://nodejs.org) and extract the binary to `dependencies/node/`
2. Download ADB platform-tools from [Google](https://developer.android.com/tools/releases/platform-tools) and extract to `dependencies/adb/`
3. Run `start.cmd` (Windows) or `./start.sh` (Linux)
4. Open `http://localhost:8000` -- use the Dependencies panel to verify and update

## Configuration

The server can be configured via environment variables or a `config.json` file:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8000` | HTTP server port |
| `ADB_PATH` | `adb` | Path to ADB executable |
| `CONFIG_PATH` | `config.json` | Path to config file |

## Docker

```bash
docker build -t ws-scrcpy-web .
docker run -p 8000:8000 ws-scrcpy-web
```

Note: The container needs ADB access to Android devices. For network ADB (wireless), the devices must be reachable from the container network.

## Acknowledgments

This project is based on [ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy) by [Sergey Volkov](https://github.com/nicedayzhu) / Netris, JSC. See [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for full license details.

Screen mirroring powered by [scrcpy](https://github.com/Genymobile/scrcpy) by [Genymobile](https://github.com/Genymobile) / [Romain Vimont](https://github.com/rom1v).

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
