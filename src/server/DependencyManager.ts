// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import os from 'os';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import path from 'path';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { execFile } from 'child_process';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { pipeline } from 'stream/promises';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { promisify } from 'util';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { Writable } from 'stream';
import { DependencyStatus, compareVersions } from '../common/DependencyTypes';
import type { DependencyInfo, UpdateResult } from '../common/DependencyTypes';
import { getDependencyDefinitions, getPlatform } from './DependencyDefinitions';
import type { DependencyDefinition } from './DependencyDefinitions';

const execFileAsync = promisify(execFile);

export class DependencyManager {
    private readonly definitions: DependencyDefinition[];
    private readonly state: Map<string, DependencyInfo>;

    constructor(private readonly depsPath: string) {
        this.definitions = getDependencyDefinitions();
        this.state = new Map();

        for (const def of this.definitions) {
            this.state.set(def.name, {
                name: def.name,
                displayName: def.displayName,
                installedVersion: null,
                latestVersion: null,
                status: DependencyStatus.Unknown,
                description: def.description,
                requiresRestart: def.requiresRestart,
                pairedWith: def.pairedWith,
            });
        }
    }

    public getAll(): DependencyInfo[] {
        return Array.from(this.state.values());
    }

    public getByName(name: string): DependencyInfo | undefined {
        return this.state.get(name);
    }

    public async checkInstalled(name: string): Promise<void> {
        const def = this.definitions.find((d) => d.name === name);
        const info = this.state.get(name);
        if (!def || !info) return;

        info.status = DependencyStatus.Checking;
        try {
            info.installedVersion = await def.checkInstalled(this.depsPath);
            this.resolveStatus(info);
        } catch (err) {
            info.status = DependencyStatus.Error;
            info.errorMessage = err instanceof Error ? err.message : String(err);
        }
    }

    public async checkLatest(name: string): Promise<void> {
        const def = this.definitions.find((d) => d.name === name);
        const info = this.state.get(name);
        if (!def || !info) return;

        info.status = DependencyStatus.Checking;
        try {
            info.latestVersion = await def.checkLatest();
            this.resolveStatus(info);
        } catch (err) {
            info.status = DependencyStatus.Error;
            info.errorMessage = err instanceof Error ? err.message : String(err);
        }
    }

    public async checkAll(): Promise<void> {
        // Check all installed versions first
        for (const def of this.definitions) {
            await this.checkInstalled(def.name);
        }
        // Then check all latest versions
        for (const def of this.definitions) {
            await this.checkLatest(def.name);
        }
    }

    public async update(name: string): Promise<UpdateResult> {
        const def = this.definitions.find((d) => d.name === name);
        const info = this.state.get(name);
        if (!def || !info) {
            return { success: false, errorMessage: `Unknown dependency: ${name}`, requiresRestart: false };
        }

        info.status = DependencyStatus.Updating;
        const tmpDir = path.join(os.tmpdir(), 'ws-scrcpy-web', `update-${name}-${Date.now()}`);

        try {
            // Ensure latest version is known
            if (!info.latestVersion) {
                info.latestVersion = await def.checkLatest();
            }
            if (!info.latestVersion) {
                throw new Error('Could not determine latest version');
            }

            const version = info.latestVersion;
            const url = def.getDownloadUrl(version);

            // Create temp directory
            fs.mkdirSync(tmpDir, { recursive: true });

            // Download
            const fileName = url.split('/').pop() || `${name}-download`;
            const downloadPath = path.join(tmpDir, fileName);
            await this.download(url, downloadPath);

            // Extract / install
            await this.install(name, def, downloadPath, version, tmpDir);

            // Update state
            info.installedVersion = version;
            info.status = DependencyStatus.UpToDate;
            info.errorMessage = undefined;

            return { success: true, newVersion: version, requiresRestart: def.requiresRestart };
        } catch (err) {
            info.status = DependencyStatus.Error;
            info.errorMessage = err instanceof Error ? err.message : String(err);
            return {
                success: false,
                errorMessage: info.errorMessage,
                requiresRestart: def.requiresRestart,
            };
        } finally {
            // Clean up temp directory
            try {
                fs.rmSync(tmpDir, { recursive: true, force: true });
            } catch {
                // Best effort cleanup
            }
        }
    }

    public requestRestart(): void {
        const markerPath = path.join(this.depsPath, '.restart');
        fs.writeFileSync(markerPath, `restart-requested-${Date.now()}`);
        process.exit(75);
    }

    private resolveStatus(info: DependencyInfo): void {
        if (info.installedVersion === null) {
            info.status = DependencyStatus.Unknown;
            return;
        }
        if (info.latestVersion === null) {
            // Installed but don't know latest — keep as unknown
            info.status = DependencyStatus.Unknown;
            return;
        }
        const cmp = compareVersions(info.installedVersion, info.latestVersion);
        info.status = cmp >= 0 ? DependencyStatus.UpToDate : DependencyStatus.UpdateAvailable;
        info.errorMessage = undefined;
    }

    private async download(url: string, destPath: string): Promise<void> {
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`Download failed: HTTP ${res.status} from ${url}`);
        }
        if (!res.body) {
            throw new Error('Download failed: empty response body');
        }
        const fileStream = fs.createWriteStream(destPath);
        // Convert web ReadableStream to Node writable via pipeline
        await pipeline(res.body as unknown as NodeJS.ReadableStream, fileStream as unknown as Writable);
    }

    private async install(
        name: string,
        def: DependencyDefinition,
        downloadPath: string,
        version: string,
        tmpDir: string,
    ): Promise<void> {
        const platform = getPlatform();

        switch (name) {
            case 'nodejs':
                await this.installNodejs(downloadPath, version, tmpDir, platform);
                break;
            case 'adb':
                await this.installAdb(downloadPath, tmpDir, platform);
                break;
            case 'scrcpy-server':
                await this.installScrcpyServer(downloadPath);
                break;
            default:
                throw new Error(`No install handler for: ${name}`);
        }
    }

    private async installNodejs(
        downloadPath: string,
        version: string,
        tmpDir: string,
        platform: 'win32' | 'linux',
    ): Promise<void> {
        const destDir = path.join(this.depsPath, 'node');
        fs.mkdirSync(destDir, { recursive: true });

        if (platform === 'win32') {
            // On Windows, rename running node.exe to node.exe.old before replacing
            const runningExe = path.join(destDir, 'node.exe');
            const oldExe = path.join(destDir, 'node.exe.old');
            if (fs.existsSync(runningExe)) {
                try {
                    fs.renameSync(runningExe, oldExe);
                } catch {
                    // May fail if not the managed node
                }
            }

            // Extract zip using PowerShell
            await this.extractZip(downloadPath, tmpDir, platform);

            // Node.js archives contain a top-level dir like node-v24.14.1-win-x64/
            const archiveDir = fs.readdirSync(tmpDir).find((d) => d.startsWith('node-v'));
            if (!archiveDir) {
                throw new Error('Could not find Node.js directory in extracted archive');
            }
            const extractedPath = path.join(tmpDir, archiveDir);

            // Copy contents to destination
            this.copyDirContents(extractedPath, destDir);
        } else {
            // Extract tar.gz
            await execFileAsync('tar', ['xzf', downloadPath, '-C', tmpDir]);

            const archiveDir = fs.readdirSync(tmpDir).find((d) => d.startsWith('node-v'));
            if (!archiveDir) {
                throw new Error('Could not find Node.js directory in extracted archive');
            }
            const extractedPath = path.join(tmpDir, archiveDir);

            this.copyDirContents(extractedPath, destDir);
        }
    }

    private async installAdb(
        downloadPath: string,
        tmpDir: string,
        platform: 'win32' | 'linux',
    ): Promise<void> {
        const destDir = path.join(this.depsPath, 'adb');
        fs.mkdirSync(destDir, { recursive: true });

        // Stop ADB server before replacing files
        const ext = platform === 'win32' ? '.exe' : '';
        const adbExe = path.join(destDir, `adb${ext}`);
        if (fs.existsSync(adbExe)) {
            try {
                await execFileAsync(adbExe, ['kill-server'], { timeout: 5000 });
            } catch {
                // ADB may not be running
            }
        }

        // Extract zip (ADB is always a zip on both platforms)
        await this.extractZip(downloadPath, tmpDir, platform);

        // ADB archives contain a platform-tools/ subfolder
        const platformToolsDir = path.join(tmpDir, 'platform-tools');
        if (!fs.existsSync(platformToolsDir)) {
            throw new Error('Could not find platform-tools directory in extracted archive');
        }

        this.copyDirContents(platformToolsDir, destDir);
    }

    private async installScrcpyServer(downloadPath: string): Promise<void> {
        // scrcpy-server is a direct binary download (no archive)
        const destDir = path.join(this.depsPath, 'scrcpy-server');
        fs.mkdirSync(destDir, { recursive: true });
        const destFile = path.join(destDir, 'scrcpy-server');
        fs.copyFileSync(downloadPath, destFile);
    }

    private async extractZip(
        zipPath: string,
        destDir: string,
        platform: 'win32' | 'linux',
    ): Promise<void> {
        if (platform === 'win32') {
            await execFileAsync('powershell', [
                '-NoProfile',
                '-Command',
                `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`,
            ]);
        } else {
            await execFileAsync('unzip', ['-o', zipPath, '-d', destDir]);
        }
    }

    private copyDirContents(src: string, dest: string): void {
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                fs.mkdirSync(destPath, { recursive: true });
                this.copyDirContents(srcPath, destPath);
            } else {
                fs.copyFileSync(srcPath, destPath);
                // Preserve executable permissions on Linux
                if (getPlatform() !== 'win32') {
                    try {
                        const stat = fs.statSync(srcPath);
                        fs.chmodSync(destPath, stat.mode);
                    } catch {
                        // Best effort
                    }
                }
            }
        }
    }
}
