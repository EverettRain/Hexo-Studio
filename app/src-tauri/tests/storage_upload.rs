//! The image library against a local S3 mock:
//! `HEXO_STUDIO_TEST_S3=http://127.0.0.1:5005 cargo test --test storage_upload` with the bucket
//! `hexo-studio-test` created there (moto: `moto_server -p 5005`). Skipped without the variable.

use hexo_studio_lib::domain::catalog::{ChecklistRow, Mirror};
use hexo_studio_lib::domain::image_key::Format;
use hexo_studio_lib::domain::storage::Storage;
use hexo_studio_lib::infra::keychain::{self, Credentials};
use hexo_studio_lib::infra::project::{self, ProjectSettings};
use hexo_studio_lib::service::{adopt, images};
use std::io::Cursor;
use std::path::Path;

fn endpoint() -> Option<String> {
    std::env::var("HEXO_STUDIO_TEST_S3").ok()
}

fn jpeg(w: u32, h: u32, seed: u8) -> Vec<u8> {
    let img = image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x % 251) as u8, (y % 241) as u8, seed]));
    let mut out = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(img).write_to(&mut out, image::ImageFormat::Jpeg).unwrap();
    out.into_inner()
}

/// A store under a fresh prefix, with keys in the (in-memory) keychain.
fn settings(endpoint: &str) -> ProjectSettings {
    hexo_studio_lib::infra::install_tls();
    let run = jiff::Timestamp::now().as_nanosecond();
    let storage = Storage::S3 {
        bucket: "hexo-studio-test".into(),
        endpoint: endpoint.into(),
        region: "us-east-1".into(),
        path: format!("t{run}/"),
        public_url: format!("{endpoint}/hexo-studio-test"),
    };
    keychain::save(&storage.credential_account(), &Credentials { access_key_id: "test".into(), access_key_secret: "test".into() }).unwrap();
    ProjectSettings { name: Some("EverettBlog".into()), storage: Some(storage), ..ProjectSettings::default() }
}

fn incoming(bytes: Vec<u8>, name: Option<&str>, format: Format) -> images::Incoming {
    images::Incoming {
        bytes,
        file_name: name.map(String::from),
        format,
        name: None,
        description: "现代 C++ 的安全 内图".into(),
        today: "2025-11-24".into(),
        legacy_urls: vec![],
        now: jiff::civil::date(2025, 11, 24).at(1, 14, 20, 0),
    }
}

fn blog(root: &Path) {
    std::fs::create_dir_all(root.join("source/_posts")).unwrap();
    std::fs::write(root.join("_config.yml"), "timezone: Asia/Shanghai\n").unwrap();
    std::fs::write(root.join("package.json"), r#"{"dependencies":{"hexo":"^7"}}"#).unwrap();
}

#[tokio::test(flavor = "current_thread")]
async fn images_are_stored_once_by_uid_with_the_original_kept() {
    let Some(endpoint) = endpoint() else { return };
    // Arrange
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("blog");
    blog(&root);
    let backup = tempfile::tempdir().unwrap();
    let s = settings(&endpoint);
    let prefix = s.storage.as_ref().unwrap().prefix();
    let photo = jpeg(3000, 2000, 1);

    // Act
    let first = images::ingest(&root, &s, backup.path(), incoming(photo.clone(), Some("IMG 1442.JPG"), Format::Webp)).await.unwrap();
    let again = images::ingest(&root, &s, backup.path(), incoming(photo.clone(), Some("another name.jpg"), Format::Webp)).await.unwrap();
    let gif = images::ingest(&root, &s, backup.path(), incoming(b"GIF89a-tiny".to_vec(), Some("loading.gif"), Format::Webp)).await.unwrap();
    let pasted = images::ingest(&root, &s, backup.path(), incoming(jpeg(40, 30, 2), None, Format::Original)).await.unwrap();

    // Assert: one object per content, at <prefix><project>/<uid>.<ext>.
    let id = hexo_studio_lib::domain::image_key::content_id(&photo);
    assert_eq!(first.image.key, format!("{prefix}EverettBlog/{id}.webp"));
    assert!(!first.existed && again.existed);
    assert_eq!(again.image.id, first.image.id);
    assert!(gif.image.key.ends_with(".gif"));
    assert_eq!((pasted.image.name.as_str(), pasted.image.format), ("image-20251124-011420", Format::Original));
    assert!(pasted.image.key.ends_with(".jpg"));
    let library = project::load_catalog(&root).unwrap();
    assert_eq!(library.images.len(), 3);
    let rec = library.get(&id).unwrap();
    assert_eq!((rec.name.as_str(), rec.description.as_str(), rec.uploaded_at.as_str()), ("IMG 1442", "现代 C++ 的安全 内图", "2025-11-24"));
    assert_eq!((rec.width, rec.height), (2560, 1707));

    // Assert: the stored object is the WebP; the original sits by its uid in the backup folder.
    let store = images::open_store(&s).unwrap();
    let body = store.read(&first.image.key).await.unwrap();
    assert_eq!(image::guess_format(&body).unwrap(), image::ImageFormat::WebP);
    assert_eq!(std::fs::read(backup.path().join(format!("EverettBlog/{id}-IMG-1442.jpg"))).unwrap(), photo);
    assert_eq!(rec.original.backup, format!("EverettBlog/{id}-IMG-1442.jpg"));

    // Act / Assert: deleting removes the object and the record, not the original.
    images::delete(&root, &s, &id).await.unwrap();
    assert!(!store.exists(&first.image.key).await.unwrap());
    assert!(project::load_catalog(&root).unwrap().get(&id).is_none());
    assert!(backup.path().join(format!("EverettBlog/{id}-IMG-1442.jpg")).is_file());
}

#[tokio::test(flavor = "current_thread")]
async fn adopting_takes_old_images_in_with_their_checklist_fields_and_rewrites_the_blog() {
    let Some(endpoint) = endpoint() else { return };
    // Arrange: images flat at the root of the store, as EverettBlog's are, two with the same bytes.
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("blog");
    blog(&root);
    let backup = tempfile::tempdir().unwrap();
    let s = settings(&endpoint);
    let storage = s.storage.clone().unwrap();
    let store = images::open_store(&s).unwrap();
    let run = jiff::Timestamp::now().as_nanosecond();
    let (photo, copy, avatar, unused) =
        (format!("IMG_{run}.JPG"), format!("copy-{run}.jpg"), format!("avatar-{run}.png"), format!("unused-{run}.png"));
    let photo_bytes = jpeg(800, 600, 3);
    store.put(&photo, photo_bytes.clone(), "image/jpeg").await.unwrap();
    store.put(&copy, photo_bytes.clone(), "image/jpeg").await.unwrap();
    store.put(&avatar, jpeg(64, 64, 4), "image/png").await.unwrap();
    store.put(&unused, jpeg(32, 32, 5), "image/png").await.unwrap();
    let base = storage.public_base();
    let early = format!("---\ntitle: 早的文章\ndate: 2024-12-01 10:00:00\ncover: {base}/{photo}\n---\n![]({base}/{photo}?x-oss-process=image/resize,w_240)\n");
    let later = format!("---\ntitle: later\ndate: 2025-01-01 10:00:00\n---\n![]({base}/{copy})\n");
    std::fs::write(root.join("source/_posts/early.md"), &early).unwrap();
    std::fs::write(root.join("source/_posts/later.md"), &later).unwrap();
    std::fs::write(root.join("_config.anzhiyu.yml"), format!("avatar:\n  img: {base}/{avatar} # keep this comment\n")).unwrap();
    let blog = hexo_studio_lib::infra::blog::open(&root).unwrap();
    let checklist = [
        ChecklistRow {
            ok: Some(true),
            name: "avatar".into(),
            description: "网站头像 avatar".into(),
            url: format!("{base}/{avatar}"),
            date: "2025-03-04".into(),
            mirrors: vec![Mirror {
                label: "聚合图床".into(), url: "https://pic1.imgdb.cn/item/x.jpg".into(), date: "2025-01-19".into()
            }],
        },
        ChecklistRow { ok: Some(false), name: "unused".into(), url: format!("{base}/{unused}"), ..ChecklistRow::default() },
    ];
    let now = jiff::civil::date(2025, 11, 24).at(1, 14, 20, 0);

    // Act
    let report = adopt::run(&blog, &s, backup.path(), &checklist, "2025-11-24", now, |_| {}).await.unwrap();

    // Assert: four old objects, three images (the copy shares the photo's content).
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    let library = project::load_catalog(&root).unwrap();
    assert_eq!(library.images.len(), 3);
    let photo_img = library.by_url(&format!("{base}/{copy}")).unwrap();
    assert_eq!(photo_img.legacy_urls, [format!("{base}/{photo}"), format!("{base}/{copy}")]);
    assert_eq!(photo_img.description, "早的文章 内图");
    let avatar_img = library.by_url(&format!("{base}/{avatar}")).unwrap();
    assert_eq!((avatar_img.name.as_str(), avatar_img.ok, avatar_img.uploaded_at.as_str()), ("avatar", Some(true), "2025-03-04"));
    assert_eq!(avatar_img.mirrors.len(), 1);
    assert_eq!(library.by_url(&format!("{base}/{unused}")).unwrap().ok, Some(false));

    // Assert: the blog points at the new addresses; everything else byte for byte.
    let new_photo = photo_img.url.clone();
    assert_eq!(
        std::fs::read_to_string(root.join("source/_posts/early.md")).unwrap(),
        early.replace(&format!("{base}/{photo}"), &new_photo)
    );
    assert_eq!(std::fs::read_to_string(root.join("source/_posts/later.md")).unwrap(), later.replace(&format!("{base}/{copy}"), &new_photo));
    assert_eq!(
        std::fs::read_to_string(root.join("_config.anzhiyu.yml")).unwrap(),
        format!("avatar:\n  img: {} # keep this comment\n", avatar_img.url)
    );
    assert!(store.exists(&photo).await.unwrap(), "old objects stay");

    // Assert: both posts use the photo now, and nothing is left to adopt.
    let used = adopt::usages(&blog, &s).unwrap();
    assert_eq!(used[&photo_img.id], ["source/_posts/early.md", "source/_posts/later.md"]);
    assert!(adopt::plan(&blog, &s, &checklist).unwrap().is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn the_check_tells_a_missing_bucket_from_a_reachable_one() {
    let Some(endpoint) = endpoint() else { return };
    // Arrange
    hexo_studio_lib::infra::install_tls();
    let at = |bucket: &str| Storage::S3 {
        bucket: bucket.into(),
        endpoint: endpoint.clone(),
        region: "us-east-1".into(),
        path: String::new(),
        public_url: "https://x".into(),
    };
    let keys = Credentials { access_key_id: "test".into(), access_key_secret: "test".into() };
    let missing = hexo_studio_lib::infra::store::Store::open(&at("no-such-bucket-here"), &keys).unwrap();
    let reachable = hexo_studio_lib::infra::store::Store::open(&at("hexo-studio-test"), &keys).unwrap();

    // Act
    let gone = missing.check().await;
    let fine = reachable.check().await;

    // Assert
    assert!(gone.unwrap_err().contains("存储桶不存在"));
    assert_eq!(fine, Ok(()));
}
