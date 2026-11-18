//! Uploading an image for a post: keep the original on this Mac, convert it (WebP by default),
//! put it at `<prefix><project>/<page>/<name>` in the project's store.

use crate::domain::image_key::{self, Format};
use crate::infra::image_encode;
use crate::infra::keychain;
use crate::infra::project::{self, ProjectSettings};
use crate::infra::store::Store;
use serde::Serialize;
use std::path::{Path, PathBuf};

pub struct Upload {
    /// The post's path under `_posts` / `_drafts` without `.md`, e.g. `pointer-security`.
    pub page: String,
    /// The file's own name; `None` for a pasted screenshot.
    pub file_name: Option<String>,
    pub bytes: Vec<u8>,
    pub format: Format,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Uploaded {
    pub url: String,
    pub key: String,
    /// Where the original was kept.
    pub backup: String,
    pub format: Format,
    pub original_bytes: usize,
    pub uploaded_bytes: usize,
}

/// The store a project uploads to, with its credentials from the keychain.
pub fn open_store(settings: &ProjectSettings) -> Result<Store, String> {
    let storage = settings.storage.as_ref().ok_or("还没有设置图片存储（设置 → 图片存储）。")?;
    let creds = keychain::load(&storage.credential_account())?.ok_or("钥匙串里没有这个存储桶的 AccessKey，请在设置里填写。")?;
    Store::open(storage, &creds)
}

/// The extension of the bytes themselves, for a pasted image without a name.
fn sniffed_ext(bytes: &[u8]) -> String {
    image::guess_format(bytes).ok().and_then(|f| f.extensions_str().first().copied()).unwrap_or("png").to_string()
}

/// `<backup>/<project>/<page…>`, the folder an image's original is kept in.
pub fn backup_folder(backup_dir: &Path, project: &str, page: &str) -> PathBuf {
    page.split('/').filter(|p| !p.is_empty()).map(image_key::segment).fold(backup_dir.join(image_key::segment(project)), |d, p| d.join(p))
}

/// Copies the original into `<backup>/<project>/<page>/`; a different file of the same name
/// already there gets a numbered name, the same file is not copied twice.
pub fn keep_original(dir: &Path, stem: &str, ext: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("无法创建母图目录 {}：{e}", dir.display()))?;
    let name = if ext.is_empty() { image_key::segment(stem) } else { format!("{}.{ext}", image_key::segment(stem)) };
    let first = dir.join(&name);
    let mut path = first.clone();
    let mut n = 1;
    loop {
        match std::fs::read(&path) {
            Ok(existing) if existing == bytes => return Ok(path),
            Ok(_) => {
                n += 1;
                path = dir.join(image_key::numbered(&name, n));
            }
            Err(_) => break,
        }
    }
    std::fs::write(&path, bytes).map_err(|e| format!("无法保存母图 {}：{e}", path.display()))?;
    Ok(path)
}

/// The bytes to upload and their extension: WebP (off the async threads, it takes a while for a
/// large photo) or the original.
pub async fn convert(bytes: Vec<u8>, ext: &str, format: Format, settings: &ProjectSettings) -> Result<(Vec<u8>, String), String> {
    match format {
        Format::Webp => {
            let (quality, max_edge) = (settings.upload.quality, settings.upload.max_edge);
            let ext2 = ext.to_string();
            let encoded = tokio::task::spawn_blocking(move || image_encode::to_webp(&bytes, &ext2, quality, max_edge))
                .await
                .map_err(|e| e.to_string())??;
            Ok((encoded.bytes, "webp".to_string()))
        }
        Format::Original => Ok((bytes, ext.to_string())),
    }
}

/// Puts the object at `wanted`, or at `wanted-2`, `-3`, … when that is taken; returns the key.
pub async fn put_free(store: &Store, wanted: &str, body: Vec<u8>, ext: &str) -> Result<String, String> {
    let mut key = wanted.to_string();
    let mut n = 1;
    while store.exists(&key).await? {
        n += 1;
        key = image_key::numbered(wanted, n);
    }
    store.put(&key, body, image_key::content_type(ext)).await?;
    Ok(key)
}

pub async fn upload(
    root: &Path,
    settings: &ProjectSettings,
    backup_dir: &Path,
    req: Upload,
    now: jiff::civil::DateTime,
) -> Result<Uploaded, String> {
    let storage = settings.storage.clone().ok_or("还没有设置图片存储（设置 → 图片存储）。")?;
    let store = open_store(settings)?;
    let project = project::project_name(root, settings);
    let (stem, ext) = match &req.file_name {
        Some(name) => {
            let (stem, ext) = image_key::split_name(name);
            (stem.to_string(), if ext.is_empty() { sniffed_ext(&req.bytes) } else { ext })
        }
        None => (image_key::screenshot_stem(now), sniffed_ext(&req.bytes)),
    };

    // The original is safe on this Mac before anything goes to the store.
    let backup = keep_original(&backup_folder(backup_dir, &project, &req.page), &stem, &ext, &req.bytes)?;

    let format = image_key::output_format(&ext, req.format);
    let original_bytes = req.bytes.len();
    let (body, out_ext) = convert(req.bytes, &ext, format, settings).await?;
    let wanted = image_key::object_key(&storage.prefix(), &project, &req.page, &stem, &out_ext);
    let uploaded_bytes = body.len();
    let key = put_free(&store, &wanted, body, &out_ext).await?;
    Ok(Uploaded { url: storage.public_url(&key), key, backup: backup.display().to_string(), format, original_bytes, uploaded_bytes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_original_is_kept_once_and_a_different_one_gets_a_number() {
        // Arrange
        let dir = tempfile::tempdir().unwrap();

        // Act
        let a = keep_original(dir.path(), "photo", "jpg", b"one").unwrap();
        let again = keep_original(dir.path(), "photo", "jpg", b"one").unwrap();
        let other = keep_original(dir.path(), "photo", "jpg", b"two").unwrap();

        // Assert
        assert_eq!(a, again);
        assert_eq!(other, dir.path().join("photo-2.jpg"));
        assert_eq!(std::fs::read(&a).unwrap(), b"one");
        assert_eq!(std::fs::read(&other).unwrap(), b"two");
    }

    #[test]
    fn a_pasted_image_is_named_by_its_content() {
        // Arrange
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2).write_to(&mut png, image::ImageFormat::Png).unwrap();

        // Act / Assert
        assert_eq!(sniffed_ext(&png.into_inner()), "png");
        assert_eq!(sniffed_ext(b"???"), "png");
    }
}
