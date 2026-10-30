//! Images dropped on the window, read for the composer (ruling R24).
//!
//! The webview gets dropped files only as paths (native drag and drop), so
//! the UI asks for an image's bytes with `read_dropped_image`. Only the
//! paths of the most recent drop can be read, only PNG, JPEG, GIF and WebP
//! files, and only up to 5 MB: type and size are checked before reading.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine;
use serde::Serialize;

/// Largest image the composer attaches.
pub const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

/// Paths of the latest drop on the window; nothing else is readable.
static DROPPED: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DroppedImage {
    pub media_type: String,
    /// The file's bytes, base64 (standard alphabet, padded).
    pub data: String,
}

/// Remembers the paths of a drop (replacing the previous drop's).
pub fn remember(paths: &[PathBuf]) {
    if let Ok(mut dropped) = DROPPED.lock() {
        *dropped = paths.to_vec();
    }
}

/// The image media type for a path's extension (case-insensitive), if allowed.
pub fn media_type(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Reads `path` if it was dropped, is an allowed image type and is small enough.
/// Errors are short codes the UI explains: `not-dropped`, `unsupported-type`,
/// `not-a-file`, `too-large`, `read-failed: …`.
pub fn read_image(path: &Path, dropped: &[PathBuf]) -> Result<DroppedImage, String> {
    if !dropped.iter().any(|p| p == path) {
        return Err("not-dropped".into());
    }
    let media_type = media_type(path).ok_or("unsupported-type")?;
    let meta = fs::metadata(path).map_err(|e| format!("read-failed: {e}"))?;
    if !meta.is_file() {
        return Err("not-a-file".into());
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err("too-large".into());
    }
    let bytes = fs::read(path).map_err(|e| format!("read-failed: {e}"))?;
    // The file may have grown since the size check.
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err("too-large".into());
    }
    Ok(DroppedImage {
        media_type: media_type.into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// `read_image` against the latest drop.
pub fn read_latest(path: &Path) -> Result<DroppedImage, String> {
    let dropped = DROPPED.lock().map_err(|_| "read-failed: lock")?.clone();
    read_image(path, &dropped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    fn file(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
        let p = dir.join(name);
        File::create(&p).unwrap().write_all(bytes).unwrap();
        p
    }

    #[test]
    fn reads_a_dropped_png_as_base64() {
        let dir = tempfile::tempdir().unwrap();
        let p = file(dir.path(), "shot.png", &[137, 80, 78, 71]);
        let img = read_image(&p, std::slice::from_ref(&p)).unwrap();
        assert_eq!(img.media_type, "image/png");
        assert_eq!(img.data, "iVBORw==");
    }

    #[test]
    fn extension_check_is_case_insensitive_and_maps_jpeg() {
        assert_eq!(media_type(Path::new("a.JPG")), Some("image/jpeg"));
        assert_eq!(media_type(Path::new("a.jpeg")), Some("image/jpeg"));
        assert_eq!(media_type(Path::new("a.WebP")), Some("image/webp"));
        assert_eq!(media_type(Path::new("a.gif")), Some("image/gif"));
        assert_eq!(media_type(Path::new("a.bmp")), None);
        assert_eq!(media_type(Path::new("png")), None);
    }

    #[test]
    fn refuses_paths_that_were_not_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let p = file(dir.path(), "a.png", b"x");
        let other = file(dir.path(), "b.png", b"x");
        assert_eq!(read_image(&p, &[other]).unwrap_err(), "not-dropped");
        assert_eq!(read_image(&p, &[]).unwrap_err(), "not-dropped");
    }

    #[test]
    fn refuses_other_file_types_without_reading() {
        let dir = tempfile::tempdir().unwrap();
        let p = file(dir.path(), "secrets.txt", b"token");
        assert_eq!(
            read_image(&p, std::slice::from_ref(&p)).unwrap_err(),
            "unsupported-type"
        );
    }

    #[test]
    fn refuses_files_over_5_mb() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("huge.png");
        File::create(&p)
            .unwrap()
            .set_len(MAX_IMAGE_BYTES + 1)
            .unwrap();
        assert_eq!(
            read_image(&p, std::slice::from_ref(&p)).unwrap_err(),
            "too-large"
        );
        let ok = dir.path().join("edge.png");
        File::create(&ok).unwrap().set_len(MAX_IMAGE_BYTES).unwrap();
        assert!(read_image(&ok, std::slice::from_ref(&ok)).is_ok());
    }

    #[test]
    fn refuses_directories_named_like_images() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("folder.png");
        fs::create_dir(&p).unwrap();
        assert_eq!(
            read_image(&p, std::slice::from_ref(&p)).unwrap_err(),
            "not-a-file"
        );
    }

    #[test]
    fn only_the_latest_drop_is_readable() {
        let dir = tempfile::tempdir().unwrap();
        let first = file(dir.path(), "first.png", b"1");
        let second = file(dir.path(), "second.png", b"2");
        remember(std::slice::from_ref(&first));
        assert!(read_latest(&first).is_ok());
        remember(std::slice::from_ref(&second));
        assert_eq!(read_latest(&first).unwrap_err(), "not-dropped");
        assert!(read_latest(&second).is_ok());
    }
}
