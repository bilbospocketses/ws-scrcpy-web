import '../../../style/dialog.css';
import type { ProbeResult } from '../../../common/ProbeResult';
import type GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import type { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import { Attribute } from '../../Attribute';
import { BaseClient } from '../../client/BaseClient';
import { DeviceProbeClient } from '../../client/DeviceProbeClient';
import { DisplayInfo } from '../../DisplayInfo';
import type { PlayerClass } from '../../player/BasePlayer';
import Size from '../../Size';
import { ToolBoxCheckbox } from '../../toolbox/ToolBoxCheckbox';
import Util from '../../Util';
import SvgImage from '../../ui/SvgImage';
import VideoSettings from '../../VideoSettings';
import type { DeviceTracker } from './DeviceTracker';
import { StreamClientScrcpy } from './StreamClientScrcpy';

interface ConfigureScrcpyEvents {
    closed: { dialog: ConfigureScrcpy; result: boolean };
}

type Range = {
    max: number;
    min: number;
    step: number;
    formatter?: (value: number) => string;
};

export class ConfigureScrcpy extends BaseClient<ParamsStreamScrcpy, ConfigureScrcpyEvents> {
    private readonly TAG: string;
    private readonly udid: string;
    private readonly escapedUdid: string;
    private readonly playerStorageKey: string;
    private deviceName: string;
    private playerName?: string;
    private videoCodecSelect?: HTMLSelectElement;
    private audioCodecSelect?: HTMLSelectElement;
    private displayInfo?: DisplayInfo;
    private background: HTMLElement;
    private connectButton?: HTMLButtonElement;
    private fitToScreenCheckbox?: HTMLInputElement;
    private resetSettingsButton?: HTMLButtonElement;
    private loadSettingsButton?: HTMLButtonElement;
    private saveSettingsButton?: HTMLButtonElement;
    private playerSelectElement?: HTMLSelectElement;
    private displayIdSelectElement?: HTMLSelectElement;
    private encoderSelectElement?: HTMLSelectElement;
    private statusElement?: HTMLElement;
    private dialogContainer?: HTMLElement;
    private advancedSection?: HTMLElement;
    private advancedChevron?: HTMLElement;
    private statusText = '';

    constructor(
        private readonly tracker: DeviceTracker,
        descriptor: GoogDeviceDescriptor,
        params: ParamsStreamScrcpy,
    ) {
        super(params);
        this.udid = descriptor.udid;
        this.escapedUdid = Util.escapeUdid(this.udid);
        this.playerStorageKey = `configure_stream::${this.escapedUdid}::player`;
        this.deviceName = descriptor['ro.product.model'];
        this.TAG = `ConfigureScrcpy[${this.udid}]`;
        this.setTitle(`${this.deviceName}. Configure stream`);
        this.background = this.createUI();
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
        // Populate encoder dropdown (video encoders)
        const encoderSelect = this.encoderSelectElement || document.createElement('select');
        let child;
        while ((child = encoderSelect.firstChild)) {
            encoderSelect.removeChild(child);
        }
        const allEncoders = ['', ...result.videoEncoders];
        allEncoders.forEach((value) => {
            const optionElement = document.createElement('option');
            optionElement.setAttribute('value', value);
            optionElement.innerText = value;
            encoderSelect.appendChild(optionElement);
        });
        this.encoderSelectElement = encoderSelect;

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

    private onPlayerChange = (): void => {
        this.updateVideoSettingsForPlayer();
    };

    private onDisplayIdChange = (): void => {
        // Display info is set during probe; just refresh player settings
        this.updateVideoSettingsForPlayer();
    };

    private getPlayer(): PlayerClass | undefined {
        if (!this.playerSelectElement) {
            return;
        }
        const playerName = this.playerSelectElement.options[this.playerSelectElement.selectedIndex].value;
        return StreamClientScrcpy.getPlayers().find((playerClass) => {
            return playerClass.playerFullName === playerName;
        });
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

    private getPreviouslyUsedPlayer(): string {
        if (!window.localStorage) {
            return '';
        }
        const result = window.localStorage.getItem(this.playerStorageKey);
        if (result) {
            return result;
        }
        return '';
    }

    private setPreviouslyUsedPlayer(playerName: string): void {
        if (!window.localStorage) {
            return;
        }
        window.localStorage.setItem(this.playerStorageKey, playerName);
    }

    private createUI(): HTMLElement {
        // Backdrop
        const background = document.createElement('div');
        background.classList.add('dialog-background');

        // Container
        const dialogContainer = (this.dialogContainer = document.createElement('div'));
        dialogContainer.classList.add('dialog-container');

        // Header: device name + close button
        const dialogHeader = document.createElement('div');
        dialogHeader.classList.add('dialog-header');
        const deviceName = document.createElement('span');
        deviceName.classList.add('dialog-title');
        deviceName.innerText = this.deviceName;
        dialogHeader.appendChild(deviceName);
        const closeButton = document.createElement('button');
        closeButton.classList.add('close-btn');
        closeButton.innerHTML = '\u00d7';
        closeButton.addEventListener('click', () => {
            this.cancel();
        });
        dialogHeader.appendChild(closeButton);

        // Body (scrollable)
        const dialogBody = document.createElement('div');
        dialogBody.classList.add('dialog-body');

        // Stream settings grid
        const controls = document.createElement('div');
        controls.classList.add('dialog-controls');

        // Player dropdown
        const playerLabel = document.createElement('label');
        playerLabel.classList.add('label');
        playerLabel.innerText = 'player:';
        controls.appendChild(playerLabel);
        const playerSelect = (this.playerSelectElement = document.createElement('select'));
        playerSelect.classList.add('input');
        playerSelect.id = playerLabel.htmlFor = `player_${this.escapedUdid}`;
        controls.appendChild(playerSelect);
        const previouslyUsedPlayer = this.getPreviouslyUsedPlayer();
        StreamClientScrcpy.getPlayers().forEach((playerClass, index) => {
            const { playerFullName } = playerClass;
            const optionElement = document.createElement('option');
            optionElement.setAttribute('value', playerFullName);
            optionElement.innerText = playerFullName;
            playerSelect.appendChild(optionElement);
            if (playerFullName === previouslyUsedPlayer) {
                playerSelect.selectedIndex = index;
            }
        });
        playerSelect.onchange = this.onPlayerChange;
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

        // Video codec dropdown
        const videoCodecLabel = document.createElement('label');
        videoCodecLabel.classList.add('label');
        videoCodecLabel.innerText = 'video codec:';
        controls.appendChild(videoCodecLabel);
        const videoCodecSelect = (this.videoCodecSelect = document.createElement('select'));
        videoCodecSelect.classList.add('input');
        videoCodecSelect.id = videoCodecLabel.htmlFor = `videoCodec_${this.escapedUdid}`;
        controls.appendChild(videoCodecSelect);

        // Audio codec dropdown
        const audioCodecLabel = document.createElement('label');
        audioCodecLabel.classList.add('label');
        audioCodecLabel.innerText = 'audio codec:';
        controls.appendChild(audioCodecLabel);
        const audioCodecSelect = (this.audioCodecSelect = document.createElement('select'));
        audioCodecSelect.classList.add('input');
        audioCodecSelect.id = audioCodecLabel.htmlFor = `audioCodec_${this.escapedUdid}`;
        controls.appendChild(audioCodecSelect);

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

        // Bitrate slider
        this.appendBasicInput(controls, {
            label: 'bitrate',
            id: 'bitrate',
            range: { min: 524288, max: 8388608, step: 524288, formatter: Util.prettyBytes },
        });

        // Max FPS slider
        this.appendBasicInput(controls, {
            label: 'max fps',
            id: 'maxFps',
            range: { min: 1, max: 60, step: 1 },
        });

        dialogBody.appendChild(controls);

        // Advanced separator + toggle
        const advancedSeparator = document.createElement('div');
        advancedSeparator.classList.add('advanced-separator');
        dialogBody.appendChild(advancedSeparator);

        const advancedToggle = document.createElement('button');
        advancedToggle.classList.add('advanced-toggle');
        advancedToggle.type = 'button';
        const advancedText = document.createTextNode('advanced ');
        advancedToggle.appendChild(advancedText);
        const advancedChevron = (this.advancedChevron = document.createElement('span'));
        advancedChevron.classList.add('chevron');
        advancedChevron.innerHTML = '\u25bc';
        advancedToggle.appendChild(advancedChevron);
        advancedToggle.addEventListener('click', this.toggleAdvanced);
        dialogBody.appendChild(advancedToggle);

        // Advanced section (collapsed by default)
        const advancedSection = (this.advancedSection = document.createElement('div'));
        advancedSection.classList.add('advanced-section');

        const advancedControls = document.createElement('div');
        advancedControls.classList.add('dialog-controls');

        // I-Frame interval
        this.appendBasicInput(advancedControls, { label: 'i-frame interval', id: 'iFrameInterval' });

        // Fit to screen toggle
        const fitLabel = document.createElement('label');
        fitLabel.innerText = 'fit to screen';
        fitLabel.classList.add('label');
        advancedControls.appendChild(fitLabel);
        const fitToggle = new ToolBoxCheckbox(
            'Fit to screen',
            { off: SvgImage.Icon.TOGGLE_OFF, on: SvgImage.Icon.TOGGLE_ON },
            'fit_to_screen',
        );
        fitToggle.getAllElements().forEach((el) => {
            advancedControls.appendChild(el);
            if (el instanceof HTMLLabelElement) {
                fitLabel.htmlFor = el.htmlFor;
                el.classList.add('input');
            }
            if (el instanceof HTMLInputElement) {
                this.fitToScreenCheckbox = el;
            }
        });
        fitToggle.addEventListener('click', (_, el) => {
            const element = el.getElement();
            this.onFitToScreenChanged(element.checked);
        });

        // Max width / Max height
        this.appendBasicInput(advancedControls, { label: 'max width', id: 'maxWidth' });
        this.appendBasicInput(advancedControls, { label: 'max height', id: 'maxHeight' });

        // Codec options
        this.appendBasicInput(advancedControls, { label: 'codec options', id: 'codecOptions' });

        advancedSection.appendChild(advancedControls);
        dialogBody.appendChild(advancedSection);

        // Settings row
        const settingsRow = document.createElement('div');
        settingsRow.classList.add('dialog-settings');

        const resetSettingsButton = (this.resetSettingsButton = document.createElement('button'));
        resetSettingsButton.classList.add('button');
        resetSettingsButton.innerText = 'reset';
        resetSettingsButton.addEventListener('click', this.resetSettings);
        settingsRow.appendChild(resetSettingsButton);

        const loadSettingsButton = (this.loadSettingsButton = document.createElement('button'));
        loadSettingsButton.classList.add('button');
        loadSettingsButton.innerText = 'load';
        loadSettingsButton.addEventListener('click', this.loadSettings);
        settingsRow.appendChild(loadSettingsButton);

        const saveSettingsButton = (this.saveSettingsButton = document.createElement('button'));
        saveSettingsButton.classList.add('button');
        saveSettingsButton.innerText = 'save';
        saveSettingsButton.addEventListener('click', this.saveSettings);
        settingsRow.appendChild(saveSettingsButton);

        dialogBody.appendChild(settingsRow);

        // Footer: status + connect button
        const dialogFooter = document.createElement('div');
        dialogFooter.classList.add('dialog-footer');
        const statusElement = document.createElement('span');
        statusElement.classList.add('status-text');
        this.statusElement = statusElement;
        dialogFooter.appendChild(statusElement);
        this.statusText = 'probing...';
        this.updateStatus();

        const connectButton = (this.connectButton = document.createElement('button'));
        connectButton.classList.add('connect-btn');
        connectButton.innerText = 'connect';
        connectButton.disabled = true;
        connectButton.addEventListener('click', this.openStream);
        dialogFooter.appendChild(connectButton);

        // Assemble
        dialogContainer.appendChild(dialogHeader);
        dialogContainer.appendChild(dialogBody);
        dialogContainer.appendChild(dialogFooter);
        background.appendChild(dialogContainer);
        background.addEventListener('click', this.onBackgroundClick);
        document.addEventListener('keydown', this.onEscapeKey);
        document.body.appendChild(background);
        return background;
    }

    private removeUI(): void {
        document.body.removeChild(this.background);
        this.connectButton?.removeEventListener('click', this.openStream);
        this.resetSettingsButton?.removeEventListener('click', this.resetSettings);
        this.loadSettingsButton?.removeEventListener('click', this.loadSettings);
        this.saveSettingsButton?.removeEventListener('click', this.saveSettings);
        this.background.removeEventListener('click', this.onBackgroundClick);
        document.removeEventListener('keydown', this.onEscapeKey);
    }

    private onBackgroundClick = (event: MouseEvent): void => {
        if (event.target !== event.currentTarget) {
            return;
        }
        this.cancel();
    };

    private toggleAdvanced = (): void => {
        if (!this.advancedSection || !this.advancedChevron) return;
        const isExpanded = this.advancedSection.classList.toggle('expanded');
        this.advancedChevron.classList.toggle('expanded', isExpanded);
    };

    private onEscapeKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            this.cancel();
        }
    };

    private cancel = (): void => {
        this.emit('closed', { dialog: this, result: false });
        this.removeUI();
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

    private openStream = (): void => {
        const videoSettings = this.buildVideoSettings();
        if (!videoSettings || !this.playerName) {
            return;
        }
        const fitToScreen = this.getFitToScreenValue();
        this.emit('closed', { dialog: this, result: true });
        this.removeUI();
        const player = StreamClientScrcpy.createPlayer(this.playerName, this.udid, this.displayInfo);
        if (!player) {
            return;
        }
        this.setPreviouslyUsedPlayer(this.playerName);
        player.setVideoSettings(videoSettings, fitToScreen, false);
        const videoCodec = this.videoCodecSelect?.value;
        const audioCodec = this.audioCodecSelect?.value;
        const encoderName = this.encoderSelectElement?.value || undefined;
        const params: ParamsStreamScrcpy = {
            ...this.params,
            udid: this.udid,
            fitToScreen,
            videoCodec,
            audioCodec,
            encoderName,
        };
        StreamClientScrcpy.start(params, player, fitToScreen, videoSettings);
    };
}
