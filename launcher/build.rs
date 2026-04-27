// Embed the app icon and version metadata into the launcher .exe so
// Windows shows branded art in Explorer, taskbar, Start Menu, and
// Add/Remove Programs. Skipped on non-Windows targets.
fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let mut res = winresource::WindowsResource::new();
    res.set_icon("../assets/tray-icon.ico");
    res.compile()
        .expect("failed to embed Windows resources into launcher.exe");
}
