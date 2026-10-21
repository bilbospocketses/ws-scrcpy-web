/**
 * What smoke row 21.1 asks of an origin, read inside the page: is it a secure
 * context, does it have WebCodecs' `VideoDecoder`, and can that decoder
 * configure h264. Passed to `page.evaluate`, so it runs in the browser and must
 * not close over anything here.
 *
 * One function for every origin a row compares (an https origin and its
 * plain-http control), so two sides can only differ in what they measure,
 * never in how.
 */
export function probeSecureContext() {
    return (async () => ({
        isSecureContext: window.isSecureContext,
        hasVideoDecoder: typeof VideoDecoder !== 'undefined',
        h264:
            typeof VideoDecoder === 'undefined'
                ? false
                : (await VideoDecoder.isConfigSupported({ codec: 'avc1.42E01E', codedWidth: 1280, codedHeight: 720 }))
                      .supported,
    }))();
}
