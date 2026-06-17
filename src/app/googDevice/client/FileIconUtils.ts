export type FileIconType = 'folder' | 'file' | 'image' | 'video' | 'audio' | 'text';

const EXTENSION_MAP: Record<string, FileIconType> = {
    // Image
    jpg: 'image',
    jpeg: 'image',
    png: 'image',
    gif: 'image',
    bmp: 'image',
    webp: 'image',
    svg: 'image',
    // Video
    mp4: 'video',
    mkv: 'video',
    avi: 'video',
    mov: 'video',
    webm: 'video',
    '3gp': 'video',
    // Audio
    mp3: 'audio',
    ogg: 'audio',
    flac: 'audio',
    aac: 'audio',
    wav: 'audio',
    m4a: 'audio',
    opus: 'audio',
    // Text/code
    txt: 'text',
    md: 'text',
    json: 'text',
    xml: 'text',
    yaml: 'text',
    yml: 'text',
    log: 'text',
    conf: 'text',
    sh: 'text',
    py: 'text',
    js: 'text',
    ts: 'text',
    html: 'text',
    css: 'text',
    csv: 'text',
};

const ICON_SVGS: Record<FileIconType, string> = {
    folder: '<svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
    file: '<svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z"/></svg>',
    image: '<svg viewBox="0 0 24 24"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>',
    video: '<svg viewBox="0 0 24 24"><path d="M4 6.47L5.76 10H20v8H4V6.47M22 4h-4l2 4h-3l-2-4h-2l2 4h-3l-2-4H8l2 4H7L5 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4z"/></svg>',
    audio: '<svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>',
    text: '<svg viewBox="0 0 24 24"><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>',
};

const ICON_COLORS: Record<FileIconType, string> = {
    folder: '#5b9aff',
    file: 'rgba(255,255,255,0.5)',
    image: '#4ade80',
    video: '#f97316',
    audio: '#c084fc',
    text: 'rgba(255,255,255,0.5)',
};

export function getFileIconType(filename: string, isDirectory: boolean, _isSymlink: boolean): FileIconType {
    if (isDirectory) return 'folder';
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    return EXTENSION_MAP[ext] ?? 'file';
}

export function createFileIcon(type: FileIconType): HTMLElement {
    const wrapper = document.createElement('span');
    wrapper.classList.add('file-icon', `file-icon-${type}`);
    wrapper.style.color = ICON_COLORS[type];
    wrapper.innerHTML = ICON_SVGS[type];
    return wrapper;
}

export function createFileIconForEntry(filename: string, isDirectory: boolean, isSymlink: boolean): HTMLElement {
    const type = getFileIconType(filename, isDirectory, isSymlink);
    const icon = createFileIcon(type);
    if (isSymlink) {
        icon.classList.add('file-icon-symlink');
    }
    return icon;
}
