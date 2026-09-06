# tray-icon-22.argb

The 22×22 pixmap the Linux tray serves (`common::tray_policy::icon_argb_22`), as
ARGB32 in network byte order — the StatusNotifierItem spec's format. Generated
from `tray-icon.png` by hand; regenerate when the icon changes:

    magick assets/tray-icon.png -resize 22x22 -depth 8 RGBA:- | node scripts/rgba-to-argb.mjs > assets/tray-icon-22.argb

`common/src/tray_policy.rs` pins its length and its corner/centre pixels in a
unit test, so a wrong byte order or size fails `cargo test`. No build or run
step invokes ImageMagick (Local-Dependencies-Only).
