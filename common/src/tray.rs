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
    Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_INFO, NIM_ADD, NIM_DELETE,
    NIM_MODIFY, NOTIFYICONDATAW,
};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    AppendMenuW, CreateIconFromResourceEx, CreatePopupMenu, CreateWindowExW, DefWindowProcW,
    DestroyIcon, DestroyMenu, DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW,
    GetWindowLongPtrW, MessageBoxW, PostQuitMessage, RegisterClassW, SetForegroundWindow,
    SetWindowLongPtrW, TrackPopupMenu, TranslateMessage, UnregisterClassW, GWLP_USERDATA, HICON,
    HMENU, HWND_MESSAGE, IDYES, LR_DEFAULTCOLOR, MB_ICONQUESTION, MB_YESNO, MF_SEPARATOR, MF_STRING,
    MSG, TPM_LEFTALIGN, TPM_RIGHTBUTTON, WINDOW_EX_STYLE, WINDOW_STYLE, WM_COMMAND, WM_LBUTTONUP,
    WM_QUIT, WM_RBUTTONUP, WM_USER, WNDCLASSW,
};
#[cfg(windows)]
use windows::Win32::UI::Shell::ShellExecuteW;
#[cfg(windows)]
use windows::Win32::Foundation::POINT;

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

/// Menu item IDs. Stable per process — see WM_COMMAND dispatch in
/// `tray_wnd_proc`. Range 100+ is conventional for app-defined items.
#[cfg(windows)]
const MENU_ID_OPEN: u32 = 100;
#[cfg(windows)]
const MENU_ID_EXIT: u32 = 101;

/// Per-tray runtime state, stashed in the window's `GWLP_USERDATA` slot.
///
/// Lifetime: allocated as a `Box`, leaked into `GWLP_USERDATA` on
/// `CreateWindowExW`, reclaimed via `Box::from_raw` in the `Drop` guard.
#[cfg(windows)]
struct TrayState {
    /// Set true when the user clicks Yes on the confirm dialog.
    confirmed: Cell<bool>,
    /// Wide-string buffers kept alive for the lifetime of the window so the
    /// PCWSTR pointers handed to Win32 stay valid across the message loop.
    confirm_title_w: Vec<u16>,
    confirm_body_w: Vec<u16>,
    /// URL provider invoked on each tray click (left-click + "Open" menu).
    /// Re-evaluated on every click so the tray reflects the current
    /// `webPort` from `config.json` even when the user flips between
    /// local and service modes mid-session (each mode binds a different
    /// port). Caching the URL once at startup, as we did pre-Theory-D,
    /// would leave the click target stale after a service-uninstall
    /// handoff that rebinds to a fresh local port.
    open_url_provider: Box<dyn Fn() -> String>,
    /// "Open ws-scrcpy-web" wide label for the popup menu.
    menu_label_open_w: Vec<u16>,
    /// "Exit" wide label for the popup menu.
    menu_label_exit_w: Vec<u16>,
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
    open_url_provider: Box<dyn Fn() -> String>,
    startup_balloon: Option<(&str, &str)>,
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
        open_url_provider,
        menu_label_open_w: to_wide("Open ws-scrcpy-web"),
        menu_label_exit_w: to_wide("Exit"),
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

    // 7b. Optional startup balloon notification. Uses NIM_MODIFY with the
    // NIF_INFO flag on the same icon — the balloon hangs off the existing
    // tray icon for a few seconds and dismisses itself. Used to surface
    // "ws-scrcpy-web tray started by launcher; close ws-scrcpy-web to
    // remove" when the launcher spawns the tray automatically in service
    // mode. Failure is logged + ignored — the tray icon itself is the
    // critical UX, the balloon is informational.
    if let Some((balloon_title, balloon_body)) = startup_balloon {
        let mut balloon_nid: NOTIFYICONDATAW = unsafe { std::mem::zeroed() };
        balloon_nid.cbSize = std::mem::size_of::<NOTIFYICONDATAW>() as u32;
        balloon_nid.hWnd = hwnd;
        balloon_nid.uID = TRAY_ICON_UID;
        balloon_nid.uFlags = NIF_INFO;
        let info_w = to_wide(balloon_body);
        let title_w = to_wide(balloon_title);
        let info_len = info_w.len().min(balloon_nid.szInfo.len() - 1);
        balloon_nid.szInfo[..info_len].copy_from_slice(&info_w[..info_len]);
        let title_len = title_w.len().min(balloon_nid.szInfoTitle.len() - 1);
        balloon_nid.szInfoTitle[..title_len].copy_from_slice(&title_w[..title_len]);
        balloon_nid.Anonymous.uTimeout = 10_000; // hint only; Windows controls actual duration
        balloon_nid.dwInfoFlags = NIIF_INFO;
        // SAFETY: balloon_nid is fully initialized; only NIF_INFO + dwInfoFlags
        // are honored on NIM_MODIFY. Failure to display the balloon is benign.
        let _ = unsafe { Shell_NotifyIconW(NIM_MODIFY, &balloon_nid) };
    }

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

/// Window procedure: receives WM_TRAY_CALLBACK on tray events plus
/// WM_COMMAND from popup-menu item clicks.
///
/// Phase 3 of the Program Files migration extends the tray beyond the
/// pre-Phase-3 single-action exit-confirm dialog:
///   - WM_LBUTTONUP  -> open `open_url` in the default browser (the most
///     common user action becomes the cheapest one)
///   - WM_RBUTTONUP  -> show a popup menu: "Open ws-scrcpy-web" + "Exit"
///   - WM_COMMAND    -> dispatch on item ID (`MENU_ID_OPEN` /
///     `MENU_ID_EXIT`); Open invokes ShellExecuteW, Exit
///     shows the confirm dialog and (on Yes) posts WM_QUIT
#[cfg(windows)]
unsafe extern "system" fn tray_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: GWLP_USERDATA was populated by `run` before any message could
    // arrive (we set it immediately after CreateWindowExW; messages are not
    // dispatched until the message pump starts). The pointer is valid for
    // the lifetime of the window. Reading it here from any handler branch
    // is sound; null check guards the (unreachable in practice) racey case.
    let state_ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut TrayState;
    let state = if state_ptr.is_null() { None } else { Some(&*state_ptr) };

    if msg == WM_TRAY_CALLBACK {
        // lParam low-word holds the mouse event. Per Win32 docs, high-word
        // holds the icon ID; we only have one icon so we don't check it.
        let event = (lparam.0 as u32) & 0xFFFF;
        if event == WM_LBUTTONUP {
            if let Some(s) = state {
                open_url_via_shell(hwnd, &(s.open_url_provider)());
            }
            return LRESULT(0);
        }
        if event == WM_RBUTTONUP {
            if let Some(s) = state {
                show_popup_menu(hwnd, s);
            }
            return LRESULT(0);
        }
    }

    if msg == WM_COMMAND {
        // wParam low-word is the menu item ID.
        let id = (wparam.0 as u32) & 0xFFFF;
        if let Some(s) = state {
            match id {
                MENU_ID_OPEN => {
                    open_url_via_shell(hwnd, &(s.open_url_provider)());
                    return LRESULT(0);
                }
                MENU_ID_EXIT => {
                    confirm_and_quit(hwnd, s);
                    return LRESULT(0);
                }
                _ => {}
            }
        }
    }

    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// Open `url_w` (a wide-string URL) using the system's default URL handler.
/// Fire-and-forget — failures fall through silently; the worst case is the
/// user's click did nothing, which they can retry.
#[cfg(windows)]
unsafe fn open_url_via_shell(hwnd: HWND, url: &str) {
    let url_w = to_wide(url);
    let verb_w = to_wide("open");
    // ShellExecuteW returns an HINSTANCE; values <= 32 indicate failure.
    // We don't care which failure mode — the click is best-effort.
    let _ = ShellExecuteW(
        hwnd,
        PCWSTR(verb_w.as_ptr()),
        PCWSTR(url_w.as_ptr()),
        PCWSTR::null(),
        PCWSTR::null(),
        windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL,
    );
}

/// Build a popup menu at the cursor and surface it as a foreground modal.
///
/// Win32 quirks worth knowing:
///   - `SetForegroundWindow` is REQUIRED before `TrackPopupMenu`; otherwise
///     the menu can dismiss itself when the user clicks anything else
///     ("phantom dismiss" behavior).
///   - `TPM_RIGHTBUTTON` lets the user dismiss the menu by clicking either
///     mouse button, matching the Windows convention for tray menus.
///   - Menu item commands arrive at the SAME WndProc via `WM_COMMAND` after
///     the menu closes. We dispatch on `MENU_ID_*` there.
#[cfg(windows)]
unsafe fn show_popup_menu(hwnd: HWND, state: &TrayState) {
    let menu = match CreatePopupMenu() {
        Ok(m) => m,
        Err(_) => return, // best-effort; click is a no-op on failure
    };
    let _ = AppendMenuW(
        menu,
        MF_STRING,
        MENU_ID_OPEN as usize,
        PCWSTR(state.menu_label_open_w.as_ptr()),
    );
    let _ = AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null());
    let _ = AppendMenuW(
        menu,
        MF_STRING,
        MENU_ID_EXIT as usize,
        PCWSTR(state.menu_label_exit_w.as_ptr()),
    );

    let mut pt = POINT::default();
    let _ = GetCursorPos(&mut pt);
    // Foreground-window dance is mandatory for popup menus from a
    // hidden/message-only host window — without it, the menu is unreliable.
    let _ = SetForegroundWindow(hwnd);
    // SAFETY: menu is owned by us; we destroy it after TrackPopupMenu
    // returns. The hwnd belongs to the calling window. Coordinates are
    // screen-relative per GetCursorPos.
    let _ = TrackPopupMenu(
        menu,
        TPM_LEFTALIGN | TPM_RIGHTBUTTON,
        pt.x,
        pt.y,
        0,
        hwnd,
        None,
    );
    let _ = DestroyMenu(menu);
}

/// Show the exit-confirm dialog. On IDYES, set the confirmed flag and
/// post WM_QUIT to unwind the message pump.
#[cfg(windows)]
unsafe fn confirm_and_quit(hwnd: HWND, state: &TrayState) {
    // SAFETY: title/body buffers are owned by TrayState and live as long as
    // the window. MessageBoxW is modal and pumps its own loop internally.
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
    _open_url_provider: Box<dyn Fn() -> String>,
    _startup_balloon: Option<(&str, &str)>,
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
        let action = run(
            b"",
            "tooltip",
            "title",
            "body",
            Box::new(|| "http://localhost:8000".to_string()),
            None,
        )
        .expect("stub must not error");
        assert_eq!(action, TrayAction::Cancelled);
    }
}
