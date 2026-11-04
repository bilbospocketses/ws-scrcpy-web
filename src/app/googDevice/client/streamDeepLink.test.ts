import { describe, expect, it, vi } from 'vitest';
import { StreamDeepLink, streamDeepLinkUdid } from './streamDeepLink';

describe('streamDeepLinkUdid (#995)', () => {
    it('reads the udid from the link the connect button carries', () => {
        expect(streamDeepLinkUdid('#!action=stream&udid=192.168.98.117%3A5555&player=webcodecs')).toBe(
            '192.168.98.117:5555',
        );
    });

    it('accepts a plain # as well as #!', () => {
        expect(streamDeepLinkUdid('#action=stream&udid=emulator-5554')).toBe('emulator-5554');
    });

    it('ignores every other action, a missing udid and an empty hash', () => {
        expect(streamDeepLinkUdid('#!action=shell&udid=emulator-5554')).toBeNull();
        expect(streamDeepLinkUdid('#!action=stream')).toBeNull();
        expect(streamDeepLinkUdid('#!action=stream&udid=')).toBeNull();
        expect(streamDeepLinkUdid('')).toBeNull();
        expect(streamDeepLinkUdid('#')).toBeNull();
    });
});

describe('StreamDeepLink (#995)', () => {
    it('opens the linked device once its connect button exists, and clears the link', () => {
        const clearHash = vi.fn();
        const link = new StreamDeepLink('#!action=stream&udid=dev-1', clearHash);
        const other = vi.fn(() => true);
        const open = vi.fn(() => true);

        link.offer('dev-2', other);
        expect(other).not.toHaveBeenCalled();
        expect(clearHash).not.toHaveBeenCalled();

        link.offer('dev-1', open);
        expect(open).toHaveBeenCalledTimes(1);
        expect(clearHash).toHaveBeenCalledTimes(1);
    });

    it('opens it only once, however often the device list is rebuilt', () => {
        const link = new StreamDeepLink('#!action=stream&udid=dev-1', vi.fn());
        const open = vi.fn(() => true);

        link.offer('dev-1', open);
        link.offer('dev-1', open);
        link.offer('dev-1', open);
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('keeps waiting while the linked device is not connected yet', () => {
        const clearHash = vi.fn();
        const link = new StreamDeepLink('#!action=stream&udid=dev-1', clearHash);
        const open = vi.fn(() => true);

        // First list: the device is there but offline, so no connect button is offered.
        link.withdraw('dev-1');
        expect(clearHash).not.toHaveBeenCalled();

        // It connects a moment later.
        link.offer('dev-1', open);
        expect(open).toHaveBeenCalledTimes(1);
        expect(clearHash).toHaveBeenCalledTimes(1);
    });

    it('stays pending when the opener reports it could not open', () => {
        const link = new StreamDeepLink('#!action=stream&udid=dev-1', vi.fn());
        const stale = vi.fn(() => false);
        const open = vi.fn(() => true);

        link.offer('dev-1', stale);
        link.offer('dev-1', open);
        expect(stale).toHaveBeenCalledTimes(1);
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('does nothing for a page loaded without a stream link', () => {
        const clearHash = vi.fn();
        const link = new StreamDeepLink('', clearHash);
        const open = vi.fn(() => true);

        link.offer('dev-1', open);
        expect(open).not.toHaveBeenCalled();
        expect(clearHash).not.toHaveBeenCalled();
    });

    it('opens a device already listed when the link is entered in the same tab', () => {
        const clearHash = vi.fn();
        const link = new StreamDeepLink('', clearHash);
        const open = vi.fn(() => true);
        link.offer('dev-1', open);

        link.onHashChange('#!action=stream&udid=dev-1');
        expect(open).toHaveBeenCalledTimes(1);
        expect(clearHash).toHaveBeenCalledTimes(1);
    });

    it('waits for a device that is not listed yet when the link is entered in the same tab', () => {
        const link = new StreamDeepLink('', vi.fn());
        const open = vi.fn(() => true);

        link.onHashChange('#!action=stream&udid=dev-1');
        expect(open).not.toHaveBeenCalled();

        link.offer('dev-1', open);
        expect(open).toHaveBeenCalledTimes(1);
    });

    it('does not use the opener of a device that has gone offline', () => {
        const link = new StreamDeepLink('', vi.fn());
        const open = vi.fn(() => true);
        link.offer('dev-1', open);
        link.withdraw('dev-1');

        link.onHashChange('#!action=stream&udid=dev-1');
        expect(open).not.toHaveBeenCalled();
    });

    it('ignores a hash change that is not a stream link', () => {
        const clearHash = vi.fn();
        const link = new StreamDeepLink('', clearHash);
        const open = vi.fn(() => true);
        link.offer('dev-1', open);

        link.onHashChange('');
        link.onHashChange('#!action=shell&udid=dev-1');
        expect(open).not.toHaveBeenCalled();
        expect(clearHash).not.toHaveBeenCalled();
    });
});
