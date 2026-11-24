//! Local document links are user initiated, but their targets come from model output.
use std::path::{Path, PathBuf};

pub fn document_path(path: &str, cwd: &str) -> Result<PathBuf, String> {
    let input = Path::new(path);
    if path.chars().any(char::is_control) || path.starts_with("//") || path.starts_with(r"\\") {
        return Err("Invalid or network file path".into());
    }
    let target = if input.is_absolute() {
        input.to_path_buf()
    } else {
        let base = Path::new(cwd);
        if !base.is_absolute() {
            return Err("The chat has no absolute working folder".into());
        }
        base.join(input)
    };
    let target = target
        .canonicalize()
        .map_err(|e| format!("Cannot find file: {e}"))?;
    if !target.is_file() {
        return Err("The link does not point to a file".into());
    }
    // Default associations for scripts, executables and shortcuts can execute code.
    // Limit shell opening to document formats; validate the resolved symlink target.
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        ext.as_str(),
        "md" | "markdown"
            | "txt"
            | "pdf"
            | "doc"
            | "docx"
            | "odt"
            | "rtf"
            | "csv"
            | "tsv"
            | "xlsx"
            | "xls"
            | "ods"
            | "pptx"
            | "ppt"
            | "odp"
            | "json"
            | "yaml"
            | "yml"
            | "toml"
            | "log"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
    ) {
        return Err("This file type cannot be opened safely from chat".into());
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_documents_and_rejects_programs_and_missing_files() {
        let dir = std::env::temp_dir().join(format!("threadgarden-links-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("spec.md"), "spec").unwrap();
        std::fs::write(dir.join("run.cmd"), "echo unsafe").unwrap();
        assert_eq!(
            document_path("spec.md", dir.to_str().unwrap()).unwrap(),
            dir.join("spec.md").canonicalize().unwrap()
        );
        assert!(document_path("run.cmd", dir.to_str().unwrap()).is_err());
        assert!(document_path("missing.md", dir.to_str().unwrap()).is_err());
        assert!(document_path("//server/spec.md", dir.to_str().unwrap()).is_err());
        std::fs::remove_file(dir.join("spec.md")).unwrap();
        std::fs::remove_file(dir.join("run.cmd")).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
