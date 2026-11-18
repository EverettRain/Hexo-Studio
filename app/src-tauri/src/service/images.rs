//! The project's image library: taking an image in (keep the original, convert, upload to
//! `<prefix><project>/<uid>.<ext>`, record it), checking, removing.

use crate::domain::catalog::{Image, Original};
use crate::domain::image_key::{self, Format};
use crate::domain::storage::Storage;
use crate::infra::image_encode;
use crate::infra::keychain;
use crate::infra::project::{self, Profile, ProjectSettings, UploadSettings};
use crate::infra::store::Store;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// A store with its credentials from the keychain.
pub fn open_store(storage: &Storage) -> Result<Store, String> {
    let creds = keychain::load(&storage.credential_account())?.ok_or("钥匙串里没有这个存储桶的 AccessKey，请在图片页的存储配置里填写。")?;
    Store::open(storage, &creds)
}

/// Where new images go.
pub fn active_profile(settings: &ProjectSettings) -> Result<&Profile, String> {
    settings.active_profile().ok_or_else(|| "还没有图片存储配置：在图片页新建一套。".to_string())
}

/// The store that holds an image: the profile whose addresses it is under.
pub fn store_for(settings: &ProjectSettings, image: &Image) -> Result<Store, String> {
    let profile = settings.profile_for_url(&image.url).ok_or("没有哪套存储配置包含这张图的地址（配置可能已删除或改过）。")?;
    open_store(&profile.storage)
}

/// The extension of the bytes themselves, for a pasted image without a name.
fn sniffed_ext(bytes: &[u8]) -> String {
    image::guess_format(bytes).ok().and_then(|f| f.extensions_str().first().copied()).unwrap_or("png").to_string()
}

/// The bytes to upload, their extension and pixel size: WebP (off the async threads, it takes
/// a while for a large photo) or the original.
async fn convert(bytes: Vec<u8>, ext: &str, format: Format, upload: &UploadSettings) -> Result<(Vec<u8>, String, u32, u32), String> {
    match format {
        Format::Webp => {
            let (quality, max_edge) = (upload.quality, upload.max_edge);
            let ext2 = ext.to_string();
            let e = tokio::task::spawn_blocking(move || image_encode::to_webp(&bytes, &ext2, quality, max_edge))
                .await
                .map_err(|e| e.to_string())??;
            Ok((e.bytes, "webp".to_string(), e.width, e.height))
        }
        Format::Original => {
            let (w, h) = image::ImageReader::new(std::io::Cursor::new(&bytes))
                .with_guessed_format()
                .ok()
                .and_then(|r| r.into_dimensions().ok())
                .unwrap_or((0, 0));
            Ok((bytes, ext.to_string(), w, h))
        }
    }
}

/// An image to take into the library.
pub struct Incoming {
    pub bytes: Vec<u8>,
    /// The file's own name; `None` for a pasted screenshot.
    pub file_name: Option<String>,
    pub format: Format,
    pub name: Option<String>,
    pub description: String,
    /// `YYYY-MM-DD`, in the blog's zone.
    pub today: String,
    pub legacy_urls: Vec<String>,
    /// `now` for naming a screenshot.
    pub now: jiff::civil::DateTime,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ingested {
    pub image: Image,
    /// It was in the library already (same content): nothing was uploaded.
    pub existed: bool,
    pub original_bytes: usize,
}

/// Takes an image in through the active profile: same content already in the library → that
/// record; otherwise the original is kept in `<backup>/<project>/<uid>-<name>` (before anything is
/// uploaded), converted, put at `<prefix><project>/<uid>.<ext>` and recorded in `images.json`.
pub async fn ingest(root: &Path, settings: &ProjectSettings, backup_dir: &Path, inc: Incoming) -> Result<Ingested, String> {
    let profile = active_profile(settings)?;
    let storage = &profile.storage;
    let id = image_key::content_id(&inc.bytes);
    let original_bytes = inc.bytes.len();
    if let Some(found) = project::load_catalog(root)?.get(&id).cloned() {
        return Ok(Ingested { image: found, existed: true, original_bytes });
    }
    let store = open_store(storage)?;
    let project_name = project::project_name(root, settings);
    let file_name = match &inc.file_name {
        Some(n) if !image_key::split_name(n).1.is_empty() => n.clone(),
        Some(n) => format!("{n}.{}", sniffed_ext(&inc.bytes)),
        None => format!("{}.{}", image_key::screenshot_stem(inc.now), sniffed_ext(&inc.bytes)),
    };
    let (stem, ext) = image_key::split_name(&file_name);
    let stem = stem.to_string();

    let backup_rel = format!("{}/{}", image_key::segment(&project_name), image_key::backup_name(&id, &file_name));
    let backup = backup_dir.join(&backup_rel);
    if let Some(dir) = backup.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("无法创建母图目录 {}：{e}", dir.display()))?;
    }
    if std::fs::read(&backup).map(|b| b != inc.bytes).unwrap_or(true) {
        std::fs::write(&backup, &inc.bytes).map_err(|e| format!("无法保存母图 {}：{e}", backup.display()))?;
    }

    let format = image_key::output_format(&ext, inc.format);
    let (body, out_ext, width, height) = convert(inc.bytes, &ext, format, &profile.upload).await?;
    let key = image_key::object_key(&storage.prefix(), &project_name, &id, &out_ext);
    let bytes = body.len() as u64;
    store.put(&key, body, image_key::content_type(&out_ext)).await?;
    let image = Image {
        id: id.clone(),
        name: inc.name.filter(|n| !n.trim().is_empty()).unwrap_or(stem),
        description: inc.description,
        ok: None,
        url: storage.public_url(&key),
        key,
        uploaded_at: inc.today,
        mirrors: Vec::new(),
        format,
        bytes,
        width,
        height,
        original: Original { file_name, bytes: original_bytes as u64, backup: backup_rel },
        legacy_urls: inc.legacy_urls,
    };
    // Added at once, by another upload of the same picture: keep that record.
    let recorded = project::update_catalog(root, |c| {
        c.add(image.clone());
        Ok(c.get(&id).cloned().expect("just added or already there"))
    })?;
    Ok(Ingested { image: recorded, existed: false, original_bytes })
}

/// The last check of an image on this Mac.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    /// Unix seconds.
    pub at: i64,
    pub ok: bool,
    /// What is wrong, when not ok.
    pub message: String,
}

/// Checks the object is in the store and its public address serves it.
pub async fn check(store: &Store, http: &reqwest::Client, image: &Image, now: i64) -> Check {
    let fail = |message: String| Check { at: now, ok: false, message };
    match store.exists(&image.key).await {
        Ok(true) => {}
        Ok(false) => return fail("存储里没有这个对象".into()),
        Err(e) => return fail(e),
    }
    // A one-byte GET, as a browser fetches the image; some hosts answer HEAD differently.
    match http.get(&image.url).header("Range", "bytes=0-0").send().await {
        Ok(r) if r.status().is_success() => Check { at: now, ok: true, message: String::new() },
        Ok(r) => fail(format!("公开地址返回 HTTP {}", r.status().as_u16())),
        Err(e) => fail(format!("公开地址无法访问：{e}")),
    }
}

/// Removes an image from its store and the library; its kept original stays on this Mac.
pub async fn delete(root: &Path, settings: &ProjectSettings, id: &str) -> Result<(), String> {
    let image = project::load_catalog(root)?.get(id).cloned().ok_or("图片库里没有这张图。")?;
    store_for(settings, &image)?.delete(&image.key).await?;
    project::update_catalog(root, |c| Ok(c.remove(id).map(|_| ())))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
