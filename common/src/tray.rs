//! Windows tray-icon event loop with exit-confirm dialog.
//!
//! Synchronous, blocking. Designed to be called from a dedicated thread
//! (the launcher) or from the main thread (the tray helper binary). Per
//! `tray-icon` 0.22 docs, the tray icon must be created on the same thread
//! that pumps the Win32 message loop, but this need not be the OS main
//! thread on Windows.
//!
//! On user click, the click handler shows a synchronous `MessageBoxW`
//! confirmation. On `IDYES`, the loop exits with [`TrayAction::ConfirmedExit`].
//! On `IDNO` / dismiss, the loop continues.
//!
//! No async runtime, no winit dependency — just `tray-icon` plus a manual
//! Win32 message pump via the `windows` crate.

use anyhow::{anyhow, Context, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tray_icon::{Icon, TrayIcon, TrayIconBuilder, TrayIconEvent};

use windows::core::PCWSTR;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetMessageW, MessageBoxW, PostQuitMessage, TranslateMessage, IDYES,
    MB_ICONQUESTION, MB_YESNO, MSG, WM_QUIT,
};

/// Result of the user's interaction with the tray.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    /// User chose "Yes" on the exit-confirmation dialog.
    ConfirmedExit,
    /// Loop exited without a user-confirmed action (reserved for future
    /// programmatic-shutdown paths; the public [`run`] never returns this
    /// today — `IDNO` keeps the loop running).
    Cancelled,
}

/// Run a tray icon event loop. BLOCKS the calling thread until the user
/// confirms exit (returns [`TrayAction::ConfirmedExit`]).
///
/// # Arguments
/// - `icon_bytes`: raw ICO bytes (typically `include_bytes!("../../assets/tray-icon.ico")`)
/// - `tooltip`: hover text on the icon
/// - `confirm_title`, `confirm_body`: text of the confirmation MessageBox
///
/// # Errors
/// Returns Err if icon decode fails, tray construction fails, or the message
/// pump itself errors.
pub fn run(
    icon_bytes: &[u8],
    tooltip: &str,
    confirm_title: &str,
    confirm_body: &str,
) -> Result<TrayAction> {
    let icon = decode_ico(icon_bytes).context("decode tray icon")?;

    // Build the tray icon. Must happen on the thread that will pump messages.
    let _tray: TrayIcon = TrayIconBuilder::new()
        .with_tooltip(tooltip)
        .with_icon(icon)
        .build()
        .map_err(|e| anyhow!("TrayIconBuilder::build failed: {e}"))?;

    // Click handler: show the confirm dialog. On YES, post WM_QUIT to break
    // the message pump; on NO, do nothing (loop continues).
    let confirmed = Arc::new(AtomicBool::new(false));
    let confirm_title_w = to_wide(confirm_title);
    let confirm_body_w = to_wide(confirm_body);
    {
        let confirmed = confirmed.clone();
        TrayIconEvent::set_event_handler(Some(move |event| {
            if !is_left_click(&event) {
                return;
            }
            // SAFETY: MessageBoxW with valid wide-string pointers; HWND::default()
            // (NULL) creates an unowned dialog, which is appropriate from a
            // background thread without a real owner window.
            let result = unsafe {
                MessageBoxW(
                    HWND::default(),
                    PCWSTR(confirm_body_w.as_ptr()),
                    PCWSTR(confirm_title_w.as_ptr()),
                    MB_YESNO | MB_ICONQUESTION,
                )
            };
            if result == IDYES {
                confirmed.store(true, Ordering::SeqCst);
                // SAFETY: PostQuitMessage is always safe to call on the
                // current thread; it just enqueues a WM_QUIT.
                unsafe { PostQuitMessage(0) };
            }
        }));
    }

    // Manual Win32 message pump. Returns when WM_QUIT is dequeued.
    pump_messages();

    if confirmed.load(Ordering::SeqCst) {
        Ok(TrayAction::ConfirmedExit)
    } else {
        Ok(TrayAction::Cancelled)
    }
}

/// Decode raw ICO bytes into a `tray_icon::Icon`. The crate's
/// `Icon::from_resource_name` and friends are platform-specific; the
/// portable path is `Icon::from_rgba`, but for an ICO we use the
/// `from_path`-equivalent via `image` would pull a heavy dep — instead we
/// rely on the `tray_icon::Icon::from_rgba` after decoding the ICO ourselves.
///
/// `tray_icon` 0.22 also exposes `Icon::from_resource` (Windows resource ID)
/// which we don't use here because we want a single embedded-bytes approach
/// that's identical across both binaries.
//
// Implementation: parse the largest image inside the ICO using the standard
// ICO format. ICOs may contain PNG-encoded entries (modern, used for sizes
// >= 256) or BMP-encoded entries (classic). Our placeholder uses PNG
// entries, so we handle the PNG path; BMP fallback is included for
// robustness when the user replaces the icon with a classic ICO.
fn decode_ico(bytes: &[u8]) -> Result<Icon> {
    let (rgba, w, h) = parse_ico_to_rgba(bytes)?;
    Icon::from_rgba(rgba, w, h).map_err(|e| anyhow!("Icon::from_rgba failed: {e}"))
}

/// Minimal ICO parser: picks the largest image entry and decodes it.
///
/// Supported entry encodings:
///   - PNG (entries whose payload starts with the PNG magic bytes)
///   - BMP (classic ICO bitmap with 32-bit RGBA)
///
/// Returns `(rgba_pixels, width, height)`.
fn parse_ico_to_rgba(bytes: &[u8]) -> Result<(Vec<u8>, u32, u32)> {
    // ICONDIR header: 6 bytes (reserved u16=0, type u16=1, count u16).
    if bytes.len() < 6 {
        return Err(anyhow!("ico: file too small for header"));
    }
    let icon_type = u16::from_le_bytes([bytes[2], bytes[3]]);
    let count = u16::from_le_bytes([bytes[4], bytes[5]]) as usize;
    if icon_type != 1 {
        return Err(anyhow!("ico: not an icon (type={icon_type})"));
    }
    if count == 0 {
        return Err(anyhow!("ico: zero entries"));
    }

    // ICONDIRENTRY: 16 bytes each, starting at offset 6.
    let mut best: Option<(u32, usize, usize)> = None; // (area, offset, size)
    for i in 0..count {
        let entry_off = 6 + i * 16;
        if bytes.len() < entry_off + 16 {
            return Err(anyhow!("ico: truncated entry table"));
        }
        let w = match bytes[entry_off] {
            0 => 256u32,
            n => n as u32,
        };
        let h = match bytes[entry_off + 1] {
            0 => 256u32,
            n => n as u32,
        };
        let size = u32::from_le_bytes([
            bytes[entry_off + 8],
            bytes[entry_off + 9],
            bytes[entry_off + 10],
            bytes[entry_off + 11],
        ]) as usize;
        let off = u32::from_le_bytes([
            bytes[entry_off + 12],
            bytes[entry_off + 13],
            bytes[entry_off + 14],
            bytes[entry_off + 15],
        ]) as usize;
        let area = w * h;
        if best.map(|(a, _, _)| area > a).unwrap_or(true) {
            best = Some((area, off, size));
        }
    }

    let (_area, off, size) = best.ok_or_else(|| anyhow!("ico: no entries selected"))?;
    if bytes.len() < off + size {
        return Err(anyhow!("ico: entry payload out of bounds"));
    }
    let payload = &bytes[off..off + size];

    if payload.len() >= 8 && &payload[0..8] == b"\x89PNG\r\n\x1a\n" {
        decode_png_to_rgba(payload)
    } else {
        decode_bmp_entry_to_rgba(payload)
    }
}

/// Decode a PNG payload using the `png` crate (already pulled in transitively
/// by `tray-icon`).
fn decode_png_to_rgba(payload: &[u8]) -> Result<(Vec<u8>, u32, u32)> {
    // png 0.18 requires `BufRead + Seek`; wrap the slice.
    let decoder = png::Decoder::new(std::io::Cursor::new(payload));
    let mut reader = decoder
        .read_info()
        .map_err(|e| anyhow!("png decode info: {e}"))?;
    let mut buf = vec![0u8; reader.output_buffer_size().unwrap_or(0)];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| anyhow!("png decode frame: {e}"))?;
    let (w, h) = (info.width, info.height);

    // Normalize to RGBA8.
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
        png::ColorType::Rgb => {
            let src = &buf[..info.buffer_size()];
            let mut out = Vec::with_capacity((w * h * 4) as usize);
            for chunk in src.chunks_exact(3) {
                out.extend_from_slice(chunk);
                out.push(0xFF);
            }
            out
        }
        png::ColorType::GrayscaleAlpha => {
            let src = &buf[..info.buffer_size()];
            let mut out = Vec::with_capacity((w * h * 4) as usize);
            for chunk in src.chunks_exact(2) {
                out.extend_from_slice(&[chunk[0], chunk[0], chunk[0], chunk[1]]);
            }
            out
        }
        png::ColorType::Grayscale => {
            let src = &buf[..info.buffer_size()];
            let mut out = Vec::with_capacity((w * h * 4) as usize);
            for &g in src {
                out.extend_from_slice(&[g, g, g, 0xFF]);
            }
            out
        }
        png::ColorType::Indexed => {
            return Err(anyhow!(
                "png: indexed-color icons not supported; use RGBA PNGs"
            ))
        }
    };
    Ok((rgba, w, h))
}

/// Decode a classic ICO BMP entry (32bpp BI_RGB only — sufficient for the
/// fallback case; if the user supplies a more exotic ICO we'll surface a
/// clear error rather than try to handle every BMP variant).
fn decode_bmp_entry_to_rgba(payload: &[u8]) -> Result<(Vec<u8>, u32, u32)> {
    // BITMAPINFOHEADER is 40 bytes; ICO BMP entries omit the BITMAPFILEHEADER.
    if payload.len() < 40 {
        return Err(anyhow!("bmp: header too short"));
    }
    let header_size = u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]);
    if header_size != 40 {
        return Err(anyhow!("bmp: unsupported header size {header_size}"));
    }
    let w = i32::from_le_bytes([payload[4], payload[5], payload[6], payload[7]]) as u32;
    // ICO BMP height is doubled (XOR mask + AND mask). The image height is half.
    let raw_h = i32::from_le_bytes([payload[8], payload[9], payload[10], payload[11]]);
    let h = raw_h.unsigned_abs() / 2;
    let bpp = u16::from_le_bytes([payload[14], payload[15]]);
    if bpp != 32 {
        return Err(anyhow!(
            "bmp: only 32bpp ICO entries supported (got {bpp}); replace icon with PNG-encoded ICO"
        ));
    }

    let row_stride = (w * 4) as usize;
    let pixels_off = 40usize;
    let needed = pixels_off + row_stride * h as usize;
    if payload.len() < needed {
        return Err(anyhow!("bmp: pixel data truncated"));
    }

    // BMP rows are bottom-up and BGRA; convert to top-down RGBA.
    let mut out = vec![0u8; row_stride * h as usize];
    for y in 0..h as usize {
        let src_row = pixels_off + (h as usize - 1 - y) * row_stride;
        let dst_row = y * row_stride;
        for x in 0..w as usize {
            let s = src_row + x * 4;
            let d = dst_row + x * 4;
            // BGRA -> RGBA
            out[d] = payload[s + 2];
            out[d + 1] = payload[s + 1];
            out[d + 2] = payload[s];
            out[d + 3] = payload[s + 3];
        }
    }
    Ok((out, w, h))
}

/// Win32 message pump. Runs until `WM_QUIT` is posted (e.g., by our click
/// handler after IDYES).
fn pump_messages() {
    let mut msg = MSG::default();
    loop {
        // SAFETY: GetMessageW is the canonical blocking message dequeue.
        // The HWND parameter being `Some(HWND::default())` (NULL) means
        // "any window owned by the calling thread", which is correct for a
        // tray-icon-only thread.
        let ret = unsafe { GetMessageW(&mut msg, HWND::default(), 0, 0) };
        // ret.0 is BOOL: 0 = WM_QUIT, -1 = error, >0 = normal.
        if ret.0 == 0 {
            break;
        }
        if ret.0 == -1 {
            // Error from Win32. Bail rather than busy-loop.
            break;
        }
        if msg.message == WM_QUIT {
            break;
        }
        // SAFETY: msg was just populated by a successful GetMessageW.
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// True if the event represents a user-initiated left click on the tray icon.
///
/// `tray-icon` 0.22 emits a `TrayIconEvent` enum variant for clicks; we
/// treat a left-button "Up" event as "the user clicked." Right clicks are
/// reserved for the future context menu; we ignore them today.
fn is_left_click(event: &TrayIconEvent) -> bool {
    use tray_icon::{MouseButton, MouseButtonState};
    if let TrayIconEvent::Click {
        button,
        button_state,
        ..
    } = event
    {
        return *button == MouseButton::Left && *button_state == MouseButtonState::Up;
    }
    false
}

/// Convert a Rust `&str` to a NUL-terminated UTF-16 vector for Win32 PCWSTR.
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_wide_appends_nul_terminator() {
        let v = to_wide("Hi");
        assert_eq!(v, vec![b'H' as u16, b'i' as u16, 0]);
    }

    #[test]
    fn to_wide_handles_empty_string() {
        let v = to_wide("");
        assert_eq!(v, vec![0]);
    }

    #[test]
    fn to_wide_handles_non_ascii() {
        // "é" is U+00E9, fits in a single u16.
        let v = to_wide("é");
        assert_eq!(v, vec![0x00E9, 0]);
    }

    #[test]
    fn parse_ico_rejects_too_small() {
        let err = parse_ico_to_rgba(&[0u8; 4]).unwrap_err();
        assert!(err.to_string().contains("too small"));
    }

    #[test]
    fn parse_ico_rejects_wrong_type() {
        // Header that claims type=2 (cursor) instead of 1 (icon).
        let mut buf = vec![0u8; 6];
        buf[2] = 2;
        buf[4] = 1;
        let err = parse_ico_to_rgba(&buf).unwrap_err();
        assert!(err.to_string().contains("not an icon"));
    }

    #[test]
    fn parse_ico_rejects_zero_entries() {
        // Type=1, count=0.
        let buf = vec![0u8, 0, 1, 0, 0, 0];
        let err = parse_ico_to_rgba(&buf).unwrap_err();
        assert!(err.to_string().contains("zero entries"));
    }

    #[test]
    fn parse_ico_decodes_real_placeholder() {
        // The repo's placeholder ICO must be parseable by our minimal parser
        // — this is the smoke test that protects us from a regression in the
        // ICO -> RGBA path.
        let bytes: &[u8] = include_bytes!("../../assets/tray-icon.ico");
        let (rgba, w, h) = parse_ico_to_rgba(bytes).expect("parse placeholder ico");
        assert!(w > 0 && h > 0);
        assert_eq!(rgba.len(), (w * h * 4) as usize);
    }

    // TODO: tray-loop integration test. Driving an actual TrayIconBuilder +
    // MessageBoxW path requires a Win32 message pump and synthetic input,
    // which would need a UI-test harness (e.g., spawning a child process and
    // injecting WM_LBUTTONUP). Out of scope for P4a unit tests.
}
