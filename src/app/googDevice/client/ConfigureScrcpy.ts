import {
    audioCaptureSupported,
    audioDupSupported,
    audioEnabledDefault,
    defaultAudioSourceForSdk,
    type AudioSource,
} from '../../../common/AudioDefaults';
import { AudioSettingsStore } from '../../client/AudioSettingsStore';
import type { ProbeResult } from '../../../common/ProbeResult';
import type GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import type { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import { Attribute } from '../../Attribute';
import { DeviceProbeClient } from '../../client/DeviceProbeClient';
import { DisplayInfo } from '../../DisplayInfo';
import type { PlayerClass } from '../../player/BasePlayer';
import Size from '../../Size';
import Util from '../../Util';
import VideoSettings from '../../VideoSettings';
import { Modal } from '../../ui/Modal';
import type { DeviceTracker } from './DeviceTracker';
import { StreamClientScrcpy } from './StreamClientScrcpy';

type Range = {
    max: number;
    min: number;
    step: number;
    formatter?: (value: number) => string;
};

export class ConfigureScrcpy extends Modal {
    private readonly TAG: string;
    private readonly udid: string;
    private readonly escapedUdid: string;
    private readonly tracker: DeviceTracker;
    private readonly params: ParamsStreamScrcpy;
    private playerName?: string;
    private videoCodecSelect?: HTMLSelectElement;
    private audioCodecSelect?: HTMLSelectElement;
    private audioSourceSelect?: HTMLSelectElement;
    private audioEnabledCheckbox?: HTMLInputElement;
    private readonly deviceKind?: 'phone' | 'tablet' | 'tv' | undefined;
    private readonly sdkInt: number;
    private readonly savedAudio: ReturnType<typeof AudioSettingsStore.load>;
    private displayInfo?: DisplayInfo;
    private connectButton?: HTMLButtonElement;
    private fitToScreenCheckbox?: HTMLInputElement;
    private saveSettingsButton?: HTMLButtonElement;
    private displayIdSelectElement?: HTMLSelectElement;
    private encoderSelectElement?: HTMLSelectElement;
    private allVideoEncoders: string[] = [];
    private statusElement?: HTMLElement;
    private advancedChevron?: HTMLElement;
    private statusText = '';

    // advancedSection is queried from DOM in populateUI, used by toggleAdvanced
    private advancedSection?: HTMLElement;

    constructor(
        tracker: DeviceTracker,
        descriptor: GoogDeviceDescriptor,
        deviceLabel: string,
        params: ParamsStreamScrcpy,
        onClose?: (result: boolean) => void,
    ) {
        super({
            title: deviceLabel,
            onClose: onClose as ((result: unknown) => void) | undefined,
        });
        this.tracker = tracker;
        this.params = params;
        this.udid = descriptor.udid;
        this.escapedUdid = Util.escapeUdid(this.udid);
        this.deviceKind = descriptor.deviceKind;
        this.sdkInt = Number.parseInt(descriptor['ro.build.version.sdk'], 10);
        this.savedAudio = AudioSettingsStore.load(descriptor.udid);
        this.TAG = `ConfigureScrcpy[${this.udid}]`;
        this.populateUI();
        this.runProbe();
    }

    public getTracker(): DeviceTracker {
        return this.tracker;
    }

    private async runProbe(): Promise<void> {
        this.setStatus('Probing...');
        try {
            const result = await DeviceProbeClient.probe(this.udid, {
                hostname: this.params.hostname || window.location.hostname,
                port: this.params.port || Number.parseInt(window.location.port, 10) || 80,
                secure: this.params.secure || false,
            });
            this.onProbeResult(result);
        } catch (err) {
            this.setStatus(`Probe failed: ${(err as Error).message}`);
        }
    }

    private async onProbeResult(result: ProbeResult): Promise<void> {
        // Stash full encoder list; dropdown is filtered by codec further down
        this.allVideoEncoders = result.videoEncoders;
        if (!this.encoderSelectElement) {
            this.encoderSelectElement = document.createElement('select');
        }
        this.populateEncoderDropdown('');
        let child;

        // Populate video codec dropdown, preferring H.265 (hardware) then AV1
        if (this.videoCodecSelect) {
            while ((child = this.videoCodecSelect.firstChild)) {
                this.videoCodecSelect.removeChild(child);
            }
            const videoCodecs = await this.filterSupportedCodecs(this.detectVideoCodecs(result.videoEncoders));
            videoCodecs.forEach((codec) => {
                const opt = document.createElement('option');
                opt.value = codec;
                opt.innerText = codec;
                this.videoCodecSelect!.appendChild(opt);
            });
        }

        // Populate audio codec dropdown
        if (this.audioCodecSelect) {
            while ((child = this.audioCodecSelect.firstChild)) {
                this.audioCodecSelect.removeChild(child);
            }
            const audioCodecs = this.detectAudioCodecs(result.audioEncoders);
            audioCodecs.forEach((codec) => {
                const opt = document.createElement('option');
                opt.value = codec;
                opt.innerText = codec;
                this.audioCodecSelect!.appendChild(opt);
            });
            // Apply saved codec if it's one of the available options for this device,
            // otherwise leave the first option (opus) selected.
            const savedCodec = this.savedAudio?.codec;
            if (savedCodec && audioCodecs.includes(savedCodec)) {
                this.audioCodecSelect.value = savedCodec;
            }
        }

        // Populate display selector with probe data (single default display)
        if (this.displayIdSelectElement) {
            while ((child = this.displayIdSelectElement.firstChild)) {
                this.displayIdSelectElement.removeChild(child);
            }
            const displayId = DisplayInfo.DEFAULT_DISPLAY;
            const optionElement = document.createElement('option');
            optionElement.setAttribute('value', displayId.toString());
            optionElement.innerText = `ID: ${displayId}; ${result.width}x${result.height}`;
            this.displayIdSelectElement.appendChild(optionElement);
            this.displayInfo = new DisplayInfo(displayId, new Size(result.width, result.height), 0, 0, 0);
        }

        // Apply player video settings (may reset dropdowns from stored prefs)
        this.updateVideoSettingsForPlayer();

        // Apply preferred codec/encoder defaults if stored settings didn't set them
        if (this.videoCodecSelect) {
            const currentCodec = this.videoCodecSelect.value;
            if (!currentCodec || currentCodec === 'h264') {
                const opts = Array.from(this.videoCodecSelect.options);
                const hevcOpt = opts.find((o) => o.value === 'h265');
                if (hevcOpt) {
                    this.videoCodecSelect.selectedIndex = hevcOpt.index;
                }
                // H.264 stays as default if H.265 unavailable; AV1 is software-only and slow
            }
        }
        // Now that the codec is settled (stored prefs or default), filter encoders to match
        this.populateEncoderDropdown(this.videoCodecSelect?.value || '');
        if (this.encoderSelectElement) {
            const currentEncoder = this.encoderSelectElement.value;
            if (!currentEncoder) {
                const opts = Array.from(this.encoderSelectElement.options);
                const hevcHw = opts.find((o) => /\.mtk\.hevc\.|\.qcom\.hevc\.|\.exynos\.hevc\./i.test(o.value));
                if (hevcHw) {
                    this.encoderSelectElement.selectedIndex = hevcHw.index;
                }
            }
        }

        // Mark ready
        this.setStatus('Ready');
        if (this.connectButton) {
            this.connectButton.disabled = false;
        }
    }

    private encoderMatchesCodec(encoderName: string, codec: string): boolean {
        if (!encoderName) return true;
        const lower = encoderName.toLowerCase();
        switch (codec) {
            case 'h264':
                return lower.includes('.avc.') || lower.includes('.h264.');
            case 'h265':
                return lower.includes('.hevc.');
            case 'av1':
                return lower.includes('.av1.');
            default:
                return true;
        }
    }

    private populateEncoderDropdown(codec: string): void {
        if (!this.encoderSelectElement) return;
        const previousValue = this.encoderSelectElement.value;
        while (this.encoderSelectElement.firstChild) {
            this.encoderSelectElement.removeChild(this.encoderSelectElement.firstChild);
        }
        const matching = codec
            ? this.allVideoEncoders.filter((e) => this.encoderMatchesCodec(e, codec))
            : this.allVideoEncoders;
        const options = ['', ...matching];
        options.forEach((value) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.innerText = value;
            this.encoderSelectElement!.appendChild(opt);
        });
        if (previousValue && options.includes(previousValue)) {
            this.encoderSelectElement.value = previousValue;
        } else if (matching.length > 0) {
            this.encoderSelectElement.value = matching[0];
        }
    }

    private onVideoCodecChange = (): void => {
        if (!this.videoCodecSelect) return;
        this.populateEncoderDropdown(this.videoCodecSelect.value);
    };

    private detectVideoCodecs(encoders: string[]): string[] {
        const codecs: string[] = [];
        const joined = encoders.join(' ').toLowerCase();
        if (joined.includes('.avc.') || joined.includes('.h264.')) codecs.push('h264');
        if (joined.includes('.hevc.')) codecs.push('h265');
        if (joined.includes('.av1.')) codecs.push('av1');
        if (codecs.length === 0) codecs.push('h264');
        return codecs;
    }

    private async filterSupportedCodecs(codecs: string[]): Promise<string[]> {
        if (typeof VideoDecoder === 'undefined' || typeof VideoDecoder.isConfigSupported !== 'function') {
            return codecs;
        }
        const codecMap: Record<string, string> = {
            h264: 'avc1.42E01E',
            h265: 'hev1.1.6.L93.B0',
            av1: 'av01.0.04M.08',
        };
        const supported: string[] = [];
        for (const codec of codecs) {
            // H.264 is universally supported — skip the check (Firefox isConfigSupported
            // returns false for some H.264 profile strings despite decoding fine)
            if (codec === 'h264') {
                supported.push(codec);
                continue;
            }
            const webCodecStr = codecMap[codec];
            if (!webCodecStr) {
                supported.push(codec);
                continue;
            }
            try {
                const result = await VideoDecoder.isConfigSupported({ codec: webCodecStr });
                if (result.supported) {
                    supported.push(codec);
                } else {
                    console.log(this.TAG, `Browser does not support decoding ${codec} (${webCodecStr})`);
                }
            } catch {
                console.log(this.TAG, `Browser does not support decoding ${codec} (${webCodecStr})`);
            }
        }
        return supported.length > 0 ? supported : codecs;
    }

    private detectAudioCodecs(encoders: string[]): string[] {
        const codecs: string[] = [];
        const joined = encoders.join(' ').toLowerCase();
        if (joined.includes('.opus.')) codecs.push('opus');
        if (joined.includes('.aac.')) codecs.push('aac');
        if (joined.includes('.flac.')) codecs.push('flac');
        codecs.push('raw');
        return codecs;
    }

    private setStatus(text: string): void {
        this.statusText = text.toLowerCase();
        this.updateStatus();
    }

    private updateStatus(): void {
        if (!this.statusElement) {
            return;
        }
        this.statusElement.textContent = this.statusText;
        this.statusElement.className = 'status-text';
        if (this.statusText.startsWith('probing')) {
            this.statusElement.classList.add('status-probing');
        } else if (this.statusText === 'ready') {
            this.statusElement.classList.add('status-ready');
        } else if (this.statusText.startsWith('probe failed')) {
            this.statusElement.classList.add('status-error');
        }
    }

    private onDisplayIdChange = (): void => {
        // Display info is set during probe; just refresh player settings
        this.updateVideoSettingsForPlayer();
    };

    private getPlayer(): PlayerClass | undefined {
        return StreamClientScrcpy.getPlayers()[0];
    }

    private updateVideoSettingsForPlayer(): void {
        const player = this.getPlayer();
        if (player) {
            this.playerName = player.playerFullName;
            const storedOrPreferred = player.loadVideoSettings(this.udid, this.displayInfo);
            const fitToScreen = player.getFitToScreenStatus(this.udid, this.displayInfo);
            this.fillInputsFromVideoSettings(storedOrPreferred, fitToScreen);
        }
    }

    private getBasicInput(id: string): HTMLInputElement | null {
        const element = document.getElementById(`${id}_${this.escapedUdid}`);
        if (!element) {
            return null;
        }
        return element as HTMLInputElement;
    }

    private fillInputsFromVideoSettings(videoSettings: VideoSettings, fitToScreen: boolean): void {
        if (this.displayInfo && this.displayInfo.displayId !== videoSettings.displayId) {
            console.error(this.TAG, `Display id from VideoSettings and DisplayInfo don't match`);
        }
        this.fillBasicInput({ id: 'bitrate' }, videoSettings);
        this.fillBasicInput({ id: 'maxFps' }, videoSettings);
        this.fillBasicInput({ id: 'iFrameInterval' }, videoSettings);
        // this.fillBasicInput({ id: 'displayId' }, videoSettings);
        this.fillBasicInput({ id: 'codecOptions' }, videoSettings);
        if (videoSettings.bounds) {
            const { width, height } = videoSettings.bounds;
            const widthInput = this.getBasicInput('maxWidth');
            if (widthInput) {
                widthInput.value = width.toString(10);
            }
            const heightInput = this.getBasicInput('maxHeight');
            if (heightInput) {
                heightInput.value = height.toString(10);
            }
        }
        if (this.encoderSelectElement) {
            const encoderName = videoSettings.encoderName || '';
            const option = Array.from(this.encoderSelectElement.options).find((element) => {
                return element.value === encoderName;
            });
            if (option) {
                this.encoderSelectElement.selectedIndex = option.index;
            }
        }
        if (this.fitToScreenCheckbox) {
            this.fitToScreenCheckbox.checked = fitToScreen;
            this.onFitToScreenChanged(fitToScreen);
        }
    }

    private onFitToScreenChanged(checked: boolean) {
        const heightInput = this.getBasicInput('maxHeight');
        const widthInput = this.getBasicInput('maxWidth');
        if (!this.fitToScreenCheckbox || !heightInput || !widthInput) {
            return;
        }
        heightInput.disabled = widthInput.disabled = checked;
        if (checked) {
            heightInput.setAttribute(Attribute.VALUE, heightInput.value);
            heightInput.value = '';
            widthInput.setAttribute(Attribute.VALUE, widthInput.value);
            widthInput.value = '';
        } else {
            const storedHeight = heightInput.getAttribute(Attribute.VALUE);
            if (typeof storedHeight === 'string') {
                heightInput.value = storedHeight;
                heightInput.removeAttribute(Attribute.VALUE);
            }
            const storedWidth = widthInput.getAttribute(Attribute.VALUE);
            if (typeof storedWidth === 'string') {
                widthInput.value = storedWidth;
                widthInput.removeAttribute(Attribute.VALUE);
            }
        }
    }

    private fillBasicInput(opts: { id: keyof VideoSettings }, videoSettings: VideoSettings): void {
        const input = this.getBasicInput(opts.id);
        const value = videoSettings[opts.id];
        if (input) {
            if (typeof value !== 'undefined' && value !== '-' && value !== 0 && value !== null) {
                input.value = value.toString(10);
                if (input.getAttribute('type') === 'range') {
                    input.dispatchEvent(new Event('input'));
                }
            } else {
                input.value = '';
            }
        }
    }

    private appendBasicInput(
        parent: HTMLElement,
        opts: { label: string; id: string; range?: Range },
    ): HTMLInputElement {
        const label = document.createElement('label');
        label.classList.add('label');
        label.innerText = `${opts.label}:`;
        label.id = `label_${opts.id}_${this.escapedUdid}`;
        parent.appendChild(label);
        const input = document.createElement('input');
        input.classList.add('input');
        input.id = label.htmlFor = `${opts.id}_${this.escapedUdid}`;
        const { range } = opts;
        if (range) {
            label.setAttribute('title', opts.label);
            input.oninput = () => {
                const value = range.formatter ? range.formatter(Number.parseInt(input.value, 10)) : input.value;
                label.innerText = `${opts.label} (${value}):`;
            };
            input.setAttribute('type', 'range');
            input.setAttribute('max', range.max.toString());
            input.setAttribute('min', range.min.toString());
            input.setAttribute('step', range.step.toString());
        }
        parent.appendChild(input);
        return input;
    }

    private getNumberValueFromInput(name: string): number {
        const value = (document.getElementById(`${name}_${this.escapedUdid}`) as HTMLInputElement).value;
        return Number.parseInt(value, 10);
    }

    private getStringValueFromInput(name: string): string {
        return (document.getElementById(`${name}_${this.escapedUdid}`) as HTMLInputElement).value;
    }

    private getValueFromSelect(name: string): string {
        const select = document.getElementById(`${name}_${this.escapedUdid}`) as HTMLSelectElement;
        return select.options[select.selectedIndex].value;
    }

    private buildVideoSettings(): VideoSettings | null {
        try {
            const bitrate = this.getNumberValueFromInput('bitrate');
            const maxFps = this.getNumberValueFromInput('maxFps');
            const iFrameInterval = this.getNumberValueFromInput('iFrameInterval');
            const maxWidth = this.getNumberValueFromInput('maxWidth');
            const maxHeight = this.getNumberValueFromInput('maxHeight');
            const displayId = this.getNumberValueFromInput('displayId');
            const codecOptions = this.getStringValueFromInput('codecOptions') || undefined;
            let bounds: Size | undefined;
            if (!isNaN(maxWidth) && !isNaN(maxHeight) && maxWidth && maxHeight) {
                bounds = new Size(maxWidth, maxHeight);
            }
            const encoderName = this.getValueFromSelect('encoderName') || undefined;
            return new VideoSettings({
                bitrate,
                bounds,
                maxFps,
                iFrameInterval,
                displayId,
                codecOptions,
                encoderName,
            });
        } catch (error: any) {
            console.error(this.TAG, error.message);
            return null;
        }
    }

    private getFitToScreenValue(): boolean {
        if (!this.fitToScreenCheckbox) {
            return false;
        }
        return this.fitToScreenCheckbox.checked;
    }

    protected buildBody(container: HTMLElement): void {
        // Create empty skeleton — instance fields are NOT available yet (super() is still running).
        // With ES2022 useDefineForClassFields, ALL field declarations (even !:) emit initializers
        // that run after super(), clobbering anything set here. So we store nothing — populateUI()
        // queries these elements from the DOM via this.bodyEl after super() completes.
        const controls = document.createElement('div');
        controls.classList.add('modal-controls');
        container.appendChild(controls);

        const advancedSeparator = document.createElement('div');
        advancedSeparator.classList.add('modal-advanced-separator');
        container.appendChild(advancedSeparator);

        const advancedToggle = document.createElement('button');
        advancedToggle.classList.add('modal-advanced-toggle');
        advancedToggle.type = 'button';
        container.appendChild(advancedToggle);

        const advancedSection = document.createElement('div');
        advancedSection.classList.add('modal-advanced');
        container.appendChild(advancedSection);
    }

    protected override buildFooter(): HTMLElement | null {
        // Create the footer structure — populateUI() will fill in the status element and connect button
        const footer = document.createElement('div');
        return footer;
    }

    private populateUI(): void {
        const controls = this.bodyEl.querySelector('.modal-controls') as HTMLElement;

        // Initialize player settings (single WebCodecs player, no dropdown needed)
        this.updateVideoSettingsForPlayer();

        // Display dropdown
        const displayIdLabel = document.createElement('label');
        displayIdLabel.classList.add('label');
        displayIdLabel.innerText = 'display:';
        controls.appendChild(displayIdLabel);
        if (!this.displayIdSelectElement) {
            this.displayIdSelectElement = document.createElement('select');
        }
        controls.appendChild(this.displayIdSelectElement);
        this.displayIdSelectElement.classList.add('input');
        this.displayIdSelectElement.id = displayIdLabel.htmlFor = `displayId_${this.escapedUdid}`;
        this.displayIdSelectElement.onchange = this.onDisplayIdChange;

        // ── Video settings group ──────────────────────────────────────────
        // Video codec dropdown
        const videoCodecLabel = document.createElement('label');
        videoCodecLabel.classList.add('label');
        videoCodecLabel.innerText = 'video codec:';
        controls.appendChild(videoCodecLabel);
        const videoCodecSelect = (this.videoCodecSelect = document.createElement('select'));
        videoCodecSelect.classList.add('input');
        videoCodecSelect.id = videoCodecLabel.htmlFor = `videoCodec_${this.escapedUdid}`;
        videoCodecSelect.addEventListener('change', this.onVideoCodecChange);
        controls.appendChild(videoCodecSelect);

        // Encoder dropdown
        const encoderLabel = document.createElement('label');
        encoderLabel.classList.add('label');
        encoderLabel.innerText = 'encoder:';
        controls.appendChild(encoderLabel);
        if (!this.encoderSelectElement) {
            this.encoderSelectElement = document.createElement('select');
        }
        controls.appendChild(this.encoderSelectElement);
        this.encoderSelectElement.classList.add('input');
        this.encoderSelectElement.id = encoderLabel.htmlFor = `encoderName_${this.escapedUdid}`;

        // Max FPS slider
        this.appendBasicInput(controls, {
            label: 'max fps',
            id: 'maxFps',
            range: { min: 1, max: 60, step: 1 },
        });

        // ── Audio settings group ──────────────────────────────────────────
        // Audio codec dropdown
        const audioCodecLabel = document.createElement('label');
        audioCodecLabel.classList.add('label');
        audioCodecLabel.innerText = 'audio codec:';
        controls.appendChild(audioCodecLabel);
        const audioCodecSelect = (this.audioCodecSelect = document.createElement('select'));
        audioCodecSelect.classList.add('input');
        audioCodecSelect.id = audioCodecLabel.htmlFor = `audioCodec_${this.escapedUdid}`;
        controls.appendChild(audioCodecSelect);

        // Audio source dropdown. Three options:
        //   playback — capture playback and also keep audio on the device (Android 13+)
        //   output   — capture the whole output; device goes silent during the session
        //   mic      — capture the device microphone
        const audioSourceLabel = document.createElement('label');
        audioSourceLabel.classList.add('label');
        audioSourceLabel.innerText = 'audio source:';
        controls.appendChild(audioSourceLabel);
        const audioSourceSelect = (this.audioSourceSelect = document.createElement('select'));
        audioSourceSelect.classList.add('input');
        audioSourceSelect.id = audioSourceLabel.htmlFor = `audioSource_${this.escapedUdid}`;
        // Source options are filtered by SDK capability — we only show what can
        // actually work on the connected device. `playback` requires Android 13+
        // (SDK 33) because the `--audio-dup` flag (which keeps device audio) is
        // Android-13-only; below that, playback would just silence the device
        // like `output` does, so it's not worth offering separately.
        const dupOk = audioDupSupported(this.sdkInt);
        const audioSourceOptions: Array<{ value: AudioSource; label: string }> = [
            { value: 'output', label: 'output — silences device during session (default)' },
        ];
        if (dupOk) {
            audioSourceOptions.push({
                value: 'playback',
                label: 'playback — keeps device audio (Android 13+)',
            });
        }
        audioSourceOptions.push({ value: 'mic', label: 'mic — captures device microphone' });
        for (const { value, label } of audioSourceOptions) {
            const opt = document.createElement('option');
            opt.value = value;
            opt.innerText = label;
            audioSourceSelect.appendChild(opt);
        }
        // Apply saved source if present and still valid for this device's SDK,
        // otherwise fall back to the SDK-aware default.
        const savedSource = this.savedAudio?.source;
        const savedSourceUsable = savedSource && audioSourceOptions.some((o) => o.value === savedSource);
        audioSourceSelect.value = savedSourceUsable ? savedSource : defaultAudioSourceForSdk(this.sdkInt);
        controls.appendChild(audioSourceSelect);

        // Enable-audio checkbox. Default:
        //   SDK<30 → off, checkbox disabled entirely (scrcpy can't capture)
        //   SDK≥30 → on, checkbox interactive
        const captureOk = audioCaptureSupported(this.sdkInt);
        const audioEnabledLabel = document.createElement('label');
        audioEnabledLabel.classList.add('label');
        audioEnabledLabel.innerText = 'enable audio:';
        controls.appendChild(audioEnabledLabel);
        const audioEnabledCheckbox = (this.audioEnabledCheckbox = document.createElement('input'));
        audioEnabledCheckbox.type = 'checkbox';
        audioEnabledCheckbox.id = audioEnabledLabel.htmlFor = `audioEnabled_${this.escapedUdid}`;
        // If the user has saved a preference for this device, honor it (gated by
        // capture support). Otherwise fall back to the kind-based default.
        const savedEnabled = this.savedAudio?.enabled;
        audioEnabledCheckbox.checked =
            captureOk && (typeof savedEnabled === 'boolean' ? savedEnabled : audioEnabledDefault(this.deviceKind));
        audioEnabledCheckbox.disabled = !captureOk;
        if (!captureOk) {
            audioEnabledLabel.title = audioEnabledCheckbox.title =
                'Android 11+ required for audio capture (device SDK too old)';
        }
        audioEnabledCheckbox.addEventListener('change', () => {
            const enabled = audioEnabledCheckbox.checked;
            if (this.audioCodecSelect) this.audioCodecSelect.disabled = !enabled;
            if (this.audioSourceSelect) this.audioSourceSelect.disabled = !enabled;
        });
        controls.appendChild(audioEnabledCheckbox);
        // Apply initial disabled state so the codec + source dropdowns track the checkbox
        audioCodecSelect.disabled = !audioEnabledCheckbox.checked;
        audioSourceSelect.disabled = !audioEnabledCheckbox.checked;

        // ── Overall bitrate (covers video + audio + control) ─────────────
        this.appendBasicInput(controls, {
            label: 'bitrate',
            id: 'bitrate',
            range: { min: 524288, max: 8388608, step: 524288, formatter: Util.prettyBytes },
        });

        // Set up the advanced toggle button (already in DOM from buildBody)
        const advancedToggle = this.bodyEl.querySelector('.modal-advanced-toggle') as HTMLButtonElement;
        const advancedText = document.createTextNode('advanced ');
        advancedToggle.appendChild(advancedText);
        const advancedChevron = (this.advancedChevron = document.createElement('span'));
        advancedChevron.classList.add('chevron');
        advancedChevron.innerHTML = '\u25bc';
        advancedToggle.appendChild(advancedChevron);
        advancedToggle.addEventListener('click', this.toggleAdvanced);

        // Fill advanced section
        const advancedSection = this.bodyEl.querySelector('.modal-advanced') as HTMLElement;
        this.advancedSection = advancedSection;

        // I-Frame interval
        this.appendBasicInput(advancedSection, { label: 'i-frame interval', id: 'iFrameInterval' });

        // Fit to screen toggle
        const fitLabel = document.createElement('label');
        fitLabel.innerText = 'fit to screen';
        fitLabel.classList.add('label');
        advancedSection.appendChild(fitLabel);
        const fitCheckbox = (this.fitToScreenCheckbox = document.createElement('input'));
        fitCheckbox.type = 'checkbox';
        fitCheckbox.id = fitLabel.htmlFor = `fit_to_screen_${this.escapedUdid}`;
        fitCheckbox.addEventListener('change', () => {
            this.onFitToScreenChanged(fitCheckbox.checked);
        });
        advancedSection.appendChild(fitCheckbox);

        // Max width / Max height
        this.appendBasicInput(advancedSection, { label: 'max width', id: 'maxWidth' });
        this.appendBasicInput(advancedSection, { label: 'max height', id: 'maxHeight' });

        // Codec options
        this.appendBasicInput(advancedSection, { label: 'codec options', id: 'codecOptions' });

        // Settings row
        const settingsRow = document.createElement('div');
        settingsRow.classList.add('modal-settings');

        const resetSettingsButton = document.createElement('button');
        resetSettingsButton.classList.add('button');
        resetSettingsButton.innerText = 'reset';
        resetSettingsButton.addEventListener('click', this.resetSettings);
        settingsRow.appendChild(resetSettingsButton);

        const loadSettingsButton = document.createElement('button');
        loadSettingsButton.classList.add('button');
        loadSettingsButton.innerText = 'load';
        loadSettingsButton.addEventListener('click', this.loadSettings);
        settingsRow.appendChild(loadSettingsButton);

        const saveSettingsButton = (this.saveSettingsButton = document.createElement('button'));
        saveSettingsButton.classList.add('button');
        saveSettingsButton.innerText = 'save';
        saveSettingsButton.addEventListener('click', this.saveSettings);
        settingsRow.appendChild(saveSettingsButton);

        this.bodyEl.appendChild(settingsRow);

        // Footer: populate the status element and connect button
        const footer = this.frameEl.querySelector('.modal-footer');
        if (footer) {
            const statusElement = document.createElement('span');
            statusElement.classList.add('status-text');
            this.statusElement = statusElement;
            footer.appendChild(statusElement);

            const connectButton = (this.connectButton = document.createElement('button'));
            connectButton.classList.add('connect-btn');
            connectButton.innerText = 'connect';
            connectButton.disabled = true;
            connectButton.addEventListener('click', this.openStream);
            footer.appendChild(connectButton);
        }
    }

    private toggleAdvanced = (): void => {
        if (!this.advancedSection || !this.advancedChevron) return;
        const isExpanded = this.advancedSection.classList.toggle('expanded');
        this.advancedChevron.classList.toggle('expanded', isExpanded);
    };

    private resetSettings = (): void => {
        const player = this.getPlayer();
        if (player) {
            this.fillInputsFromVideoSettings(player.getPreferredVideoSetting(), false);
        }
    };

    private loadSettings = (): void => {
        this.updateVideoSettingsForPlayer();
    };

    private saveSettings = (): void => {
        const videoSettings = this.buildVideoSettings();
        const player = this.getPlayer();
        if (videoSettings && player) {
            const fitToScreen = this.getFitToScreenValue();
            player.saveVideoSettings(this.udid, videoSettings, fitToScreen, this.displayInfo);
        }
        // Persist the audio group (enable / source / codec) alongside video.
        // ConnectModal.connect-button flow loads these on click via AudioSettingsStore.
        if (this.audioEnabledCheckbox && this.audioSourceSelect && this.audioCodecSelect) {
            AudioSettingsStore.save(this.udid, {
                enabled: this.audioEnabledCheckbox.checked,
                source: this.audioSourceSelect.value as AudioSource,
                codec: this.audioCodecSelect.value,
            });
        }
        if (this.saveSettingsButton) {
            const original = this.saveSettingsButton.textContent;
            this.saveSettingsButton.textContent = 'saved';
            setTimeout(() => {
                if (this.saveSettingsButton) {
                    this.saveSettingsButton.textContent = original;
                }
            }, 1500);
        }
    };

    private openStream = async (): Promise<void> => {
        // CRITICAL: Read all form values BEFORE close() removes the dialog from DOM
        const videoSettings = this.buildVideoSettings();
        if (!videoSettings || !this.playerName) {
            return;
        }
        const fitToScreen = this.getFitToScreenValue();
        const playerName = this.playerName;
        const udid = this.udid;
        const displayInfo = this.displayInfo;
        const videoCodec = this.videoCodecSelect?.value;
        const audioCodec = this.audioCodecSelect?.value;
        const audioEnabled = this.audioEnabledCheckbox?.checked ?? audioEnabledDefault(this.deviceKind);
        const audioSource = (this.audioSourceSelect?.value as AudioSource | undefined) ?? defaultAudioSourceForSdk(this.sdkInt);
        const encoderName = this.encoderSelectElement?.value || undefined;

        // Get the device label from the modal header before closing (close() removes dialog from DOM)
        const titleEl = this.dialog.querySelector('.modal-title');
        const deviceLabel = titleEl?.textContent || udid;

        this.close(true);

        const player = StreamClientScrcpy.createPlayer(playerName, udid, displayInfo);
        if (!player) {
            return;
        }
        player.setVideoSettings(videoSettings, fitToScreen, false);
        const params: ParamsStreamScrcpy = {
            ...this.params,
            udid,
            fitToScreen,
            videoCodec,
            audioCodec,
            audioEnabled,
            audioSource,
            encoderName,
        };
        const { ConnectModal } = await import('./ConnectModal');
        const deviceKind = this.tracker.getDescriptorByUdid(this.udid)?.deviceKind;
        new ConnectModal(params, player, fitToScreen, videoSettings, deviceLabel, deviceKind);
    };
}
