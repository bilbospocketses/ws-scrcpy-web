// Embed the app icon and version metadata into the tray helper .exe.
// Same icon as the launcher — visual coherence across taskbar, Run-key
// process listings, and Explorer. Skipped on non-Windows targets.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let mut res = winresource::WindowsResource::new();
    res.set_icon("../assets/tray-icon.ico");
    res.compile()
        .expect("failed to embed Windows resources into tray.exe");
}
