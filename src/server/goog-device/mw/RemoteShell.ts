import type { IPty } from 'node-pty';
import * as os from 'os';
import type WS from 'ws';
import { ACTION } from '../../../common/Action';
import { ChannelCode } from '../../../common/ChannelCode';
import type { Multiplexer } from '../../../packages/multiplexer/Multiplexer';
import type { Message } from '../../../types/Message';
import type { XtermClientMessage, XtermServiceParameters } from '../../../types/XtermMessage';
import { Config } from '../../Config';
import { Logger } from '../../Logger';
import { Mw, type RequestParameters } from '../../mw/Mw';
import { getNodePty } from '../../NodePtyResolver';

const OS_WINDOWS = os.platform() === 'win32';
const USE_BINARY = !OS_WINDOWS;
const EVENT_TYPE_SHELL = 'shell';

// #29 — allowlist of environment variables the device-shell PTY (the adb client
// + the terminal) legitimately needs. Everything else in the server's
// process.env — which may carry app/user secrets — is dropped rather than handed
// to the shell. Matched case-insensitively (Windows uses `Path`, `SystemRoot`, …).
const SHELL_ENV_ALLOW: readonly string[] = OS_WINDOWS
    ? [
          'PATH',
          'SYSTEMROOT',
          'WINDIR',
          'TEMP',
          'TMP',
          'USERPROFILE',
          'HOMEDRIVE',
          'HOMEPATH',
          'COMSPEC',
          'PATHEXT',
          'APPDATA',
          'LOCALAPPDATA',
          'NUMBER_OF_PROCESSORS',
          'PROCESSOR_ARCHITECTURE',
          'ANDROID_USER_HOME',
          'ANDROID_SDK_HOME',
          'ANDROID_ADB_SERVER_PORT',
          'ANDROID_ADB_SERVER_SOCKET',
      ]
    : [
          'PATH',
          'HOME',
          'USER',
          'LOGNAME',
          'SHELL',
          'LANG',
          'LC_ALL',
          'LC_CTYPE',
          'TMPDIR',
          'ANDROID_USER_HOME',
          'ANDROID_SDK_HOME',
          'ANDROID_ADB_SERVER_PORT',
          'ANDROID_ADB_SERVER_SOCKET',
      ];

/**
 * Build a minimal environment for the device-shell PTY instead of inheriting the
 * server's full `process.env` (#29). Only OS/adb essentials pass through; the
 * terminal vars are set explicitly.
 */
export function buildShellEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const allow = new Set(SHELL_ENV_ALLOW);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(source)) {
        if (value !== undefined && allow.has(key.toUpperCase())) {
            env[key] = value;
        }
    }
    env['TERM'] = 'xterm-256color';
    env['COLORTERM'] = 'truecolor';
    return env;
}

export class RemoteShell extends Mw {
    public static readonly TAG = 'RemoteShell';
    private static readonly log = Logger.for('RemoteShell');
    private term?: IPty;
    private initialized = false;
    private timeoutString: NodeJS.Timeout | null = null;
    private timeoutBuffer: NodeJS.Timeout | null = null;
    private terminated = false;
    private closeCode = 1000;
    private closeReason = '';

    public static override processChannel(ws: Multiplexer, code: string): Mw | undefined {
        if (code !== ChannelCode.SHEL) {
            return;
        }
        return new RemoteShell(ws);
    }

    public static override processRequest(ws: WS, params: RequestParameters): RemoteShell | undefined {
        if (params.action !== ACTION.SHELL) {
            return;
        }
        return new RemoteShell(ws);
    }

    constructor(protected override ws: WS | Multiplexer) {
        super(ws);
    }

    public createTerminal(params: XtermServiceParameters): IPty {
        const handle = getNodePty();
        if (!handle?.available || !handle.pty) {
            throw new Error(`node-pty not available: ${handle?.reason ?? 'resolver did not run'}`);
        }
        const env = buildShellEnv();
        const { cols = 80, rows = 24 } = params;
        const cwd = process.cwd();
        // v0.1.12: resolve adb via Config.adbPath instead of bare 'adb.exe'.
        // Same family of bug as the v0.1.4 AdbClient bare-'adb' issue and
        // the v0.1.9 scrcpy-server `dist/assets/` path issue — `pty.spawn`
        // here was looking up adb.exe on system PATH, which clean Win11 VMs
        // don't have. Resolves to <deps>/adb/adb.exe per the Local
        // Dependencies Only rule.
        const file = Config.getInstance().adbPath;
        const term = handle.pty.spawn(file, ['-s', params.udid, 'shell'], {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env,
            encoding: null,
        });
        const send = USE_BINARY ? this.bufferUtf8(5) : this.buffer(5);
        // @ts-expect-error node-pty docs are incorrect for `encoding: null` — data is actually a Buffer, not a string
        term.onData(send);
        term.onExit(({ exitCode: code }) => {
            if (code === 0) {
                this.closeCode = 1000;
            } else {
                this.closeCode = 4500;
            }
            this.closeReason = `[${[RemoteShell.TAG]}] terminal process exited with code: ${code}`;
            if (this.timeoutString || this.timeoutBuffer) {
                this.terminated = true;
            } else {
                this.ws.close(this.closeCode, this.closeReason);
            }
        });
        return term;
    }

    protected onSocketMessage(event: WS.MessageEvent): void {
        if (this.initialized) {
            if (!this.term) {
                return;
            }
            return this.term.write(event.data as string);
        }
        let data;
        try {
            data = JSON.parse(event.data.toString());
        } catch (error: any) {
            RemoteShell.log.error(error?.message);
            return;
        }
        this.handleMessage(data as Message).catch((error: Error) => {
            RemoteShell.log.error(error.message);
        });
    }

    private handleMessage = async (message: Message): Promise<void> => {
        if (message.type !== EVENT_TYPE_SHELL) {
            return;
        }
        const data: XtermClientMessage = message.data as XtermClientMessage;
        const { type } = data;
        if (type === 'start') {
            this.term = this.createTerminal(data);
            this.initialized = true;
        }
        if (type === 'resize') {
            if (this.term && data.cols && data.rows) {
                this.term.resize(data.cols, data.rows);
            }
        }
        if (type === 'stop') {
            this.release();
        }
    };

    // string message buffering
    private buffer(timeout: number): (data: string) => void {
        let s = '';
        return (data: string) => {
            s += data;
            if (!this.timeoutString) {
                this.timeoutString = setTimeout(() => {
                    if (this.ws.readyState === this.ws.OPEN) {
                        this.ws.send(s);
                    }
                    s = '';
                    this.timeoutString = null;
                    if (this.terminated) {
                        this.ws.close(this.closeCode, this.closeReason);
                    }
                }, timeout);
            }
        };
    }

    private bufferUtf8(timeout: number): (data: Buffer) => void {
        let buffer: Buffer[] = [];
        let length = 0;
        return (data: Buffer) => {
            buffer.push(data);
            length += data.length;
            if (!this.timeoutBuffer) {
                this.timeoutBuffer = setTimeout(() => {
                    if (this.ws.readyState === this.ws.OPEN) {
                        this.ws.send(Buffer.concat(buffer, length));
                    }
                    buffer = [];
                    this.timeoutBuffer = null;
                    length = 0;
                    if (this.terminated) {
                        this.ws.close(this.closeCode, this.closeReason);
                    }
                }, timeout);
            }
        };
    }

    public override release(): void {
        super.release();
        if (this.timeoutBuffer) {
            clearTimeout(this.timeoutBuffer);
        }
        if (this.timeoutString) {
            clearTimeout(this.timeoutString);
        }
        if (this.term) {
            this.term.kill();
        }
    }
}
