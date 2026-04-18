// Ambient declarations for non-TS module imports handled by webpack loaders.
// The actual loaders live in webpack/ws-scrcpy-web.common.ts — this file just
// tells the standalone `tsc` checker (and dts-bundle-generator) that these
// side-effect imports are valid and resolve to something at build time.

declare module '*.css';
declare module '*.svg';
declare module '*.png';
declare module '*.jpg';
declare module '*.jpeg';
declare module '*.gif';

// DefinePlugin build-time constants (see webpack/ws-scrcpy-web.common.ts).
declare const __PATHNAME__: string;
declare const __WSSCRCPY_VERSION__: string;

// scrcpy-server is a binary blob referenced as a side-effect import so webpack's
// `asset/resource` rule (module.rules in common()) emits it into dist/assets/.
// Path is relative from the source files that import it.
declare module '*/assets/scrcpy-server';
