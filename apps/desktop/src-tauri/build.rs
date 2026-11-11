fn main() {
    // Android 15+ phones may use 16 KB memory pages: the app's native library
    // loads there only with its LOAD segments aligned to 16 KB, and NDK r27
    // links to 4 KB by default. A link argument here, since the Tauri CLI sets
    // CARGO_TARGET_<triple>_RUSTFLAGS for Android, which overrides a
    // `.cargo/config.toml`. The release job checks the result.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
    tauri_build::build()
}
