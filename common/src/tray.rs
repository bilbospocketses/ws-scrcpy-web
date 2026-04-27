//! Cross-platform tray-icon event loop with exit-confirm dialog.
//!
//! ## Windows (full implementation)
//!
//! Synchronous, blocking. Designed to be called from a dedicated thread
//! (the launcher) or from the main thread (the tray helper binary).
//!
//! Built directly on `Shell_NotifyIconW` from the `windows` crate. The tray
//! icon must be created on the same thread that pumps the Win32 message
//! loop, but this need not be the OS main thread on Windows.
//!
//! On left-click, a synchronous `MessageBoxW` confirmation appears. On
//! `IDYES`, the loop exits with [`TrayAction::ConfirmedExit`]. On `IDNO` /
//! dismiss, the loop continues.
//!
//! ### Architecture
//!
//! 1. Decode the ICO bytes — pick the largest sub-image, hand its raw
//!    payload (PNG- or BMP-encoded) to `CreateIconFromResourceEx`. Win32
//!    handles both encodings natively, so we don't need an in-tree PNG
//!    decoder.
//! 2. Register a window class with a custom `WindowProc`.
//! 3. Create a hidden message-only window (`HWND_MESSAGE` parent), the
//!    canonical Win32 host for tray-icon callbacks.
//! 4. `SetWindowLongPtrW(hWnd, GWLP_USERDATA, ptr)` to give the WndProc
//!    access to a `Box<TrayState>` containing the confirm-dialog wide
//!    strings and the "user confirmed exit" flag.
//! 5. `Shell_NotifyIconW(NIM_ADD, &nid)` registers the tray icon with
//!    `uCallbackMessage = WM_USER + 1`.
//! 6. Pump messages with `GetMessageW` until `WM_QUIT` (posted by the
//!    WndProc when the user clicks Yes on the dialog).
//! 7. Cleanup runs via a `Drop` guard so it survives panics: removes the
//!    tray icon, destroys the window, destroys the HICON.
//!
//! No async runtime, no third-party tray crate, no GTK/glib transitive
//! deps on Linux builds.
//!
//! ## Linux (best-effort stub — SP3 P4b decision: path (b))
//!
//! On Linux, [`run`] is a no-op that immediately returns
//! [`TrayAction::Cancelled`]. Background:
//!
//! - A real Linux tray would need `libappindicator` + GTK at runtime and the
//!   matching `-dev` packages at compile time. Pulling those in would fail
//!   `cross check` against the default `cross-rs` Docker image and grow the
//!   dependency tree (gtk, glib, atk, gdk, gio, cairo, pango, …).
//! - P4b is best-effort either way: the web UI Settings → Stop Server button
//!   already covers the "no tray" case (shipped in P3).
//! - Returning [`TrayAction::Cancelled`] means callers (`launcher/src/tray.rs`,
//!   `tray/src/main.rs`) log a benign info message and exit/continue without
//!   shutting down anything they shouldn't. No process termination, no
//!   spurious shutdown POST. This is exactly the existing
//!   `TrayAction::Cancelled` semantics on Windows.
//!
//! A future Linux tray (libappindicator + GTK main loop, or a modern
//! StatusNotifierItem implementation) is deferred to P5+.

/// Result of the user's interaction with the tray.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayAction {
    /// User chose "Yes" on the exit-confirmation dialog.
    ConfirmedExit,
    /// Loop exited without a user-confirmed action. On Windows this is
    /// reserved for future programmatic-shutdown paths (the public [`run`]
    /// never returns this from the IDNO path — IDNO keeps the loop running).
    /// On Linux this is the immediate return value, signalling
    /// "Linux tray not implemented; do nothing."
    Cancelled,
}

#[cfg(windows)]
use anyhow::{anyhow, Context, Result};
#[cfg(windows)]
use std::cell::Cell;

#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
#[cfg(windows)]
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
#[cfg(windows)]
use windows::Win32::UI::Shell::{
    Shell_NotifyIconW, NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NOTIFYICONDATAW,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    CreateIconFromResourceEx, CreateWindowExW, DefWindowProcW, DestroyIcon, DestroyWindow,
    DispatchMessageW, GetMessageW, GetWindowLongPtrW, MessageBoxW, PostQuitMessage, RegisterClassW,
    SetWindowLongPtrW, TranslateMessage, UnregisterClassW, GWLP_USERDATA, HICON, HMENU, HWND_MESSAGE,
    IDYES, LR_DEFAULTCOLOR, MB_ICONQUESTION, MB_YESNO, MSG, WINDOW_EX_STYLE, WINDOW_STYLE,
    WM_LBUTTONUP, WM_QUIT, WM_USER, WNDCLASSW,
};

/// Custom window message: tray icon callback. The Win32 docs use
/// `WM_APP + N` or `WM_USER + N` interchangeably for app-defined messages.
#[cfg(windows)]
const WM_TRAY_CALLBACK: u32 = WM_USER + 1;

/// Tray icon ID — arbitrary but stable per (hWnd, uID) pair. We only ever
/// register one icon per window, so 1 is fine.
#[cfg(windows)]
const TRAY_ICON_UID: u32 = 1;

/// Class name for the hidden message-only window. Per-process unique; we
/// register it on first call and unregister on cleanup.
#[cfg(windows)]
const WINDOW_CLASS_NAME: &str = "WsScrcpyWebTrayClass";

/// Per-tray runtime state, stashed in the window's `GWLP_USERDATA` slot.
///
/// Lifetime: allocated as a `Box`, leaked into `GWLP_USERDATA` on
/// `CreateWindowExW`, reclaimed via `Box::from_raw` in the `Drop` guard.
#[cfg(windows)]
struct TrayState {
    /// Set true when the user clicks Yes on the confirm dialog.
    confirmed: Cell<bool>,
    /// Wide-string buffers kept alive for the lifetime of the window so the
    /// `MessageBoxW` PCWSTR pointers remain valid across the message loop.
    confirm_title_w: Vec<u16>,
    confirm_body_w: Vec<u16>,
}

/// Run a tray icon event loop. BLOCKS the calling thread until the user
/// confirms exit (returns [`TrayAction::ConfirmedExit`]).
///
/// # Arguments
/// - `icon_bytes`: raw ICO bytes (typically `include_bytes!("../../assets/tray-icon.ico")`)
/// - `tooltip`: hover text on the icon (truncated to 127 chars; Win32 limit)
/// - `confirm_title`, `confirm_body`: text of the confirmation MessageBox
///
/// # Errors
/// Returns Err if icon decode fails, window/icon construction fails, or the
/// message pump itself errors.
///
/// # Linux behavior (P4b path (b))
/// Returns [`TrayAction::Cancelled`] immediately. See module-level docs.
#[cfg(windows)]
pub fn run(
    icon_bytes: &[u8],
    tooltip: &str,
    confirm_title: &str,
    confirm_body: &str,
) -> Result<TrayAction> {
    // SAFETY: GetModuleHandleW(NULL) returns the HMODULE for the calling
    // process's executable; always safe to call.
    let hinstance: HINSTANCE = unsafe {
        GetModuleHandleW(PCWSTR::null())
            .context("GetModuleHandleW(NULL)")?
            .into()
    };

    // 1. Build HICON from the largest sub-image of the ICO.
    let icon_payload = extract_largest_ico_image(icon_bytes).context("decode tray icon")?;
    // SAFETY: CreateIconFromResourceEx reads `icon_payload.len()` bytes from
    // the slice. We pass `cxDesired = 0, cyDesired = 0` to use the image's
    // intrinsic size, and `LR_DEFAULTCOLOR` (no special flags). dwVer must
    // be 0x00030000 per the Win32 docs.
    let hicon: HICON = unsafe {
        CreateIconFromResourceEx(
            &icon_payload,
            true,
            0x00030000,
            0,
            0,
            LR_DEFAULTCOLOR,
        )
    }
    .map_err(|e| anyhow!("CreateIconFromResourceEx: {e}"))?;

    // 2. Register the window class. RegisterClassW returns 0 on failure.
    let class_name_w = to_wide(WINDOW_CLASS_NAME);
    let wnd_class = WNDCLASSW {
        lpfnWndProc: Some(tray_wnd_proc),
        hInstance: hinstance,
        lpszClassName: PCWSTR(class_name_w.as_ptr()),
        ..Default::default()
    };
    // SAFETY: WNDCLASSW is fully initialized; lpfnWndProc is a `'static fn`.
    // RegisterClassW returns 0 on failure (e.g., name already registered);
    // we treat "already registered" as benign by attempting to proceed —
    // CreateWindowExW will surface a real error if the class is bad.
    let atom = unsafe { RegisterClassW(&wnd_class) };
    if atom == 0 {
        // Class already registered (e.g., previous run on same thread) is
        // OK; CreateWindowExW will use the existing registration. We can't
        // distinguish "already registered" from real errors via the return
        // value alone, so we proceed and let CreateWindowExW be the gate.
    }

    // 3. Allocate per-tray state. Boxed so its address is stable; we'll
    //    stash the raw pointer in GWLP_USERDATA.
    let state = Box::new(TrayState {
        confirmed: Cell::new(false),
        confirm_title_w: to_wide(confirm_title),
        confirm_body_w: to_wide(confirm_body),
    });
    let state_ptr: *mut TrayState = Box::into_raw(state);

    // 4. Create the hidden message-only window. Parent = HWND_MESSAGE means
    //    the window is invisible and only receives messages.
    let window_name_w = to_wide("");
    // SAFETY: All pointers derived from owned `Vec<u16>` buffers that
    // outlive this call. HWND_MESSAGE is the documented sentinel for a
    // message-only window. hInstance is valid from GetModuleHandleW above.
    let hwnd: HWND = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class_name_w.as_ptr()),
            PCWSTR(window_name_w.as_ptr()),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            HMENU::default(),
            hinstance,
            None,
        )
    }
    .map_err(|e| {
        // Reclaim the leaked state allocation on construction failure.
        // SAFETY: state_ptr is the raw pointer we just leaked from a Box.
        unsafe { drop(Box::from_raw(state_ptr)) };
        // SAFETY: DestroyIcon on a valid HICON; no-op-safe on failure.
        unsafe { let _ = DestroyIcon(hicon); };
        anyhow!("CreateWindowExW: {e}")
    })?;

    // 5. Stash the state pointer in GWLP_USERDATA so the WndProc can find it.
    // SAFETY: hwnd is valid (just created); GWLP_USERDATA is a documented
    // per-window pointer-sized slot. We are the sole writer.
    unsafe { SetWindowLongPtrW(hwnd, GWLP_USERDATA, state_ptr as isize) };

    // 6. Construct the cleanup guard NOW so it covers all subsequent
    //    failures (NIM_ADD, message pump panics, etc.).
    let _guard = TrayCleanup {
        hwnd,
        hicon,
        state_ptr,
        class_atom: atom,
        hinstance,
        class_name_w: class_name_w.clone(),
        nid_added: Cell::new(false),
    };

    // 7. Populate NOTIFYICONDATAW and add the tray icon.
    let mut nid: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
    nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
    nid.hWnd = hwnd;
    nid.uID = TRAY_ICON_UID;
    nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP;
    nid.uCallbackMessage = WM_TRAY_CALLBACK;
    nid.hIcon = hicon;
    // szTip: [u16; 128]; copy up to 127 chars + NUL.
    let tooltip_w = to_wide(tooltip);
    let copy_len = tooltip_w.len().min(nid.szTip.len() - 1);
    nid.szTip[..copy_len].copy_from_slice(&tooltip_w[..copy_len]);
    // (Already zero-initialized, so szTip is NUL-terminated.)

    // SAFETY: nid is fully initialized; Shell_NotifyIconW reads cbSize bytes.
    let added = unsafe { Shell_NotifyIconW(NIM_ADD, &nid) };
    if !added.as_bool() {
        return Err(anyhow!("Shell_NotifyIconW(NIM_ADD) returned FALSE"));
    }
    _guard.nid_added.set(true);

    // 8. Pump messages until WM_QUIT (posted by the WndProc).
    pump_messages();

    // 9. Read the result flag before the guard runs Drop and frees state.
    // SAFETY: state_ptr points to a live Box<TrayState>; the guard hasn't
    // dropped yet (it drops at end of scope, after this block).
    let confirmed = unsafe { (*state_ptr).confirmed.get() };

    if confirmed {
        Ok(TrayAction::ConfirmedExit)
    } else {
        Ok(TrayAction::Cancelled)
    }
    // _guard drops here: NIM_DELETE → DestroyWindow → DestroyIcon →
    // reclaim state Box → UnregisterClassW.
}

/// Drop guard for tray cleanup. Ensures icon/window/state/class are torn
/// down on any return path (success, error, panic).
#[cfg(windows)]
struct TrayCleanup {
    hwnd: HWND,
    hicon: HICON,
    state_ptr: *mut TrayState,
    class_atom: u16,
    hinstance: HINSTANCE,
    class_name_w: Vec<u16>,
    nid_added: Cell<bool>,
}

#[cfg(windows)]
impl Drop for TrayCleanup {
    fn drop(&mut self) {
        // Order: remove tray icon → destroy window → free state → destroy
        // icon → unregister class. The class can survive across runs (it's
        // process-scoped); unregistering is best-effort cleanup.
        if self.nid_added.get() {
            let mut nid: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
            nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
            nid.hWnd = self.hwnd;
            nid.uID = TRAY_ICON_UID;
            // SAFETY: nid is initialized; NIM_DELETE removes the icon.
            unsafe {
                let _ = Shell_NotifyIconW(NIM_DELETE, &nid);
            }
        }
        // SAFETY: hwnd is valid (we created it); DestroyWindow is the
        // matching teardown. The WM_DESTROY this triggers is handled by
        // DefWindowProcW since our WndProc forwards unrecognized messages.
        unsafe {
            let _ = DestroyWindow(self.hwnd);
        }
        if !self.state_ptr.is_null() {
            // SAFETY: state_ptr was created by Box::into_raw and never
            // freed elsewhere; reclaim it now.
            unsafe { drop(Box::from_raw(self.state_ptr)) };
        }
        // SAFETY: hicon was created by CreateIconFromResourceEx.
        unsafe {
            let _ = DestroyIcon(self.hicon);
        }
        if self.class_atom != 0 {
            // SAFETY: class was just registered; unregistering by name
            // takes the last reference. Best-effort — ignore failures.
            unsafe {
                let _ = UnregisterClassW(PCWSTR(self.class_name_w.as_ptr()), self.hinstance);
            }
        }
    }
}

/// Window procedure: receives WM_TRAY_CALLBACK on tray events.
///
/// Reads `Box<TrayState>` from `GWLP_USERDATA`, checks if the event is a
/// left-button release, shows the confirm dialog, and (on Yes) sets the
/// confirmed flag and posts WM_QUIT to break the message pump.
#[cfg(windows)]
unsafe extern "system" fn tray_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_TRAY_CALLBACK {
        // lParam low-word holds the mouse event (WM_LBUTTONUP, etc.).
        // Per Win32 docs, the high-word holds the icon ID; we only have
        // one icon so we don't bother checking it.
        let event = (lparam.0 as u32) & 0xFFFF;
        if event == WM_LBUTTONUP {
            // SAFETY: GWLP_USERDATA was populated by `run` before the first
            // message could arrive (RegisterClassW returns before any
            // messages are dispatched, and we set it immediately after
            // CreateWindowExW). The pointer is valid for the lifetime of
            // the window.
            let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut TrayState;
            if !state_ptr.is_null() {
                let state = &*state_ptr;
                // SAFETY: title/body wide buffers are owned by TrayState
                // and live as long as the window. MessageBoxW is modal —
                // it pumps its own loop internally.
                let result = MessageBoxW(
                    hwnd,
                    PCWSTR(state.confirm_body_w.as_ptr()),
                    PCWSTR(state.confirm_title_w.as_ptr()),
                    MB_YESNO | MB_ICONQUESTION,
                );
                if result == IDYES {
                    state.confirmed.set(true);
                    PostQuitMessage(0);
                }
            }
            return LRESULT(0);
        }
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// Extract the largest sub-image from an ICO. Returns the raw payload
/// bytes (PNG- or BMP-encoded), suitable for `CreateIconFromResourceEx`.
///
/// We pick "largest" by pixel area. The Win32 API accepts both PNG-encoded
/// (modern, used for sizes >= 256) and BMP-encoded (classic) sub-images
/// directly; no in-tree decoder needed.
#[cfg(windows)]
fn extract_largest_ico_image(bytes: &[u8]) -> Result<Vec<u8>> {
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
    Ok(bytes[off..off + size].to_vec())
}

/// Win32 message pump. Runs until `WM_QUIT` is posted (e.g., by our WndProc
/// after IDYES).
#[cfg(windows)]
fn pump_messages() {
    let mut msg = MSG::default();
    loop {
        // SAFETY: GetMessageW is the canonical blocking message dequeue.
        // The HWND parameter being `HWND::default()` (NULL) means "any
        // window owned by the calling thread", which is correct for a
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

/// Convert a Rust `&str` to a NUL-terminated UTF-16 vector for Win32 PCWSTR.
#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(all(test, windows))]
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
    fn extract_ico_rejects_too_small() {
        let err = extract_largest_ico_image(&[0u8; 4]).unwrap_err();
        assert!(err.to_string().contains("too small"));
    }

    #[test]
    fn extract_ico_rejects_wrong_type() {
        // Header that claims type=2 (cursor) instead of 1 (icon).
        let mut buf = vec![0u8; 6];
        buf[2] = 2;
        buf[4] = 1;
        let err = extract_largest_ico_image(&buf).unwrap_err();
        assert!(err.to_string().contains("not an icon"));
    }

    #[test]
    fn extract_ico_rejects_zero_entries() {
        // Type=1, count=0.
        let buf = vec![0u8, 0, 1, 0, 0, 0];
        let err = extract_largest_ico_image(&buf).unwrap_err();
        assert!(err.to_string().contains("zero entries"));
    }

    #[test]
    fn extract_ico_decodes_real_placeholder() {
        // The repo's placeholder ICO must be parseable by our minimal
        // extractor — this is the smoke test that protects us from a
        // regression in the ICO-entry-selection path.
        let bytes: &[u8] = include_bytes!("../../assets/tray-icon.ico");
        let payload = extract_largest_ico_image(bytes).expect("parse placeholder ico");
        assert!(!payload.is_empty());
        // Sanity: payload should be either PNG (starts with PNG magic) or
        // a BMP DIB (starts with header size = 40 little-endian).
        let is_png = payload.len() >= 8 && &payload[0..8] == b"\x89PNG\r\n\x1a\n";
        let is_bmp = payload.len() >= 4
            && u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]) == 40;
        assert!(is_png || is_bmp, "payload is neither PNG nor BMP DIB");
    }

    // TODO: tray-loop integration test. Driving an actual Shell_NotifyIconW
    // + MessageBoxW path requires synthetic input via SendInput or
    // PostMessage from a sibling thread, which would need a UI-test harness.
    // Out of scope for unit tests.
}

// =====================================================================
// Linux (and other non-Windows) stub — SP3 P4b decision: path (b).
//
// Returns `TrayAction::Cancelled` immediately. Callers
// (`launcher/src/tray.rs`, `tray/src/main.rs`) treat this as
// "tray-not-shown; do nothing." A real Linux tray (libappindicator + GTK
// main loop) is deferred to a later milestone. See module-level docs for
// the full rationale.
// =====================================================================

/// Linux / non-Windows stub for [`run`]. Always returns
/// [`Ok(TrayAction::Cancelled)`] without showing any UI.
///
/// The signature matches the Windows implementation so callers can invoke
/// `common::tray::run(...)` unchanged across platforms. All four arguments
/// are unused on this platform.
#[cfg(not(windows))]
pub fn run(
    _icon_bytes: &[u8],
    _tooltip: &str,
    _confirm_title: &str,
    _confirm_body: &str,
) -> anyhow::Result<TrayAction> {
    Ok(TrayAction::Cancelled)
}

#[cfg(all(test, not(windows)))]
mod linux_stub_tests {
    use super::*;

    #[test]
    fn run_returns_cancelled_on_non_windows() {
        // Smoke test: the stub is a no-op that never errors and never
        // claims a confirmed exit. Caller code (launcher tray spawn,
        // tray-helper main) is allowed to depend on this being a fast
        // synchronous return.
        let action = run(b"", "tooltip", "title", "body").expect("stub must not error");
        assert_eq!(action, TrayAction::Cancelled);
    }
}
