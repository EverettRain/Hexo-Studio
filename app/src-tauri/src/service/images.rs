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

/// How a WebP is made: quality 1–100, and the longest edge it is scaled down to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Encoding {
    pub quality: u8,
    pub max_edge: u32,
}

impl From<&UploadSettings> for Encoding {
    fn from(u: &UploadSettings) -> Self {
        Encoding { quality: u.quality, max_edge: u.max_edge }
    }
}

/// The bytes to upload, their extension and pixel size: WebP (off the async threads, it takes
/// a while for a large photo) or the original.
async fn convert(bytes: Vec<u8>, ext: &str, format: Format, encoding: Encoding) -> Result<(Vec<u8>, String, u32, u32), String> {
    match format {
        Format::Webp => {
            let (quality, max_edge) = (encoding.quality.clamp(1, 100), encoding.max_edge);
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
    /// For this image only (chosen in the import panel); `None` uses the profile's.
    pub encoding: Option<Encoding>,
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

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measured {
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
}

/// An image as it would be uploaded, worked out without uploading: for the import panel.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub id: String,
    /// The library holds this picture already: uploading it gives that record.
    pub existing: Option<Image>,
    pub original: Measured,
    /// What would be uploaded: WebP, or the original (asked for, or a GIF / SVG / icon).
    pub format: Format,
    pub output: Measured,
    /// The converted image, base64, to judge the quality by; `None` when the original is kept.
    pub preview: Option<String>,
}

/// Converts an image as `ingest` would, without keeping or uploading anything.
pub async fn prepare(root: &Path, bytes: Vec<u8>, file_name: Option<&str>, asked: Format, encoding: Encoding) -> Result<Prepared, String> {
    use base64::Engine as _;
    let id = image_key::content_id(&bytes);
    let existing = project::load_catalog(root)?.get(&id).cloned();
    let ext = match file_name.map(image_key::split_name) {
        Some((_, e)) if !e.is_empty() => e.to_string(),
        _ => sniffed_ext(&bytes),
    };
    let (ow, oh) = image::ImageReader::new(std::io::Cursor::new(&bytes)).with_guessed_format().ok().and_then(|r| r.into_dimensions().ok()).unwrap_or((0, 0));
    let original = Measured { bytes: bytes.len() as u64, width: ow, height: oh };
    let format = image_key::output_format(&ext, asked);
    let (out, _, width, height) = convert(bytes, &ext, format, encoding).await?;
    let preview = (format == Format::Webp).then(|| base64::engine::general_purpose::STANDARD.encode(&out));
    Ok(Prepared { id, existing, original, format, output: Measured { bytes: out.len() as u64, width, height }, preview })
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
    let encoding = inc.encoding.unwrap_or_else(|| Encoding::from(&profile.upload));
    let (body, out_ext, width, height) = convert(inc.bytes, &ext, format, encoding).await?;
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

    fn photo(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x % 251) as u8, (y % 241) as u8, ((x * y) % 239) as u8]));
        let mut out = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img).write_to(&mut out, image::ImageFormat::Png).unwrap();
        out.into_inner()
    }

    fn run<T>(f: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Builder::new_current_thread().build().unwrap().block_on(f)
    }

    #[test]
    fn prepare_converts_with_the_given_encoding_and_keeps_nothing() {
        // Arrange
        let dir = tempfile::tempdir().unwrap();
        let bytes = photo(400, 200);

        // Act
        let small = run(prepare(dir.path(), bytes.clone(), Some("shot.png"), Format::Webp, Encoding { quality: 40, max_edge: 100 })).unwrap();
        let large = run(prepare(dir.path(), bytes.clone(), Some("shot.png"), Format::Webp, Encoding { quality: 95, max_edge: 4000 })).unwrap();

        // Assert
        assert_eq!((small.original.width, small.original.height, small.original.bytes), (400, 200, bytes.len() as u64));
        assert_eq!((small.output.width, small.output.height), (100, 50));
        assert_eq!((large.output.width, large.output.height), (400, 200));
        assert!(small.output.bytes < large.output.bytes);
        assert_eq!(small.format, Format::Webp);
        assert!(small.preview.as_deref().is_some_and(|p| !p.is_empty()));
        assert!(small.existing.is_none());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "nothing written");
    }

    #[test]
    fn prepare_keeps_the_original_when_asked_or_for_a_gif() {
        // Arrange
        let dir = tempfile::tempdir().unwrap();
        let bytes = photo(40, 20);
        let enc = Encoding { quality: 80, max_edge: 10 };

        // Act
        let original = run(prepare(dir.path(), bytes.clone(), Some("a.png"), Format::Original, enc)).unwrap();
        let gif = run(prepare(dir.path(), bytes.clone(), Some("a.gif"), Format::Webp, enc)).unwrap();

        // Assert
        assert_eq!((original.format, original.output.bytes, original.output.width, original.preview), (Format::Original, bytes.len() as u64, 40, None));
        assert_eq!(gif.format, Format::Original);
    }
}
