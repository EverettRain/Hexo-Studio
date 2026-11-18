//! Uploads through the real store client against a local S3 mock:
//! `HEXO_STUDIO_TEST_S3=http://127.0.0.1:5005 cargo test --test storage_upload` with the bucket
//! `hexo-studio-test` created there (moto: `moto_server -p 5005`). Skipped without the variable.

use hexo_studio_lib::domain::image_key::Format;
use hexo_studio_lib::domain::storage::Storage;
use hexo_studio_lib::infra::keychain::{self, Credentials};
use hexo_studio_lib::infra::project::ProjectSettings;
use hexo_studio_lib::service::images::{self, Upload};
use std::io::Cursor;

fn endpoint() -> Option<String> {
    std::env::var("HEXO_STUDIO_TEST_S3").ok()
}

fn jpeg(w: u32, h: u32) -> Vec<u8> {
    let img = image::RgbImage::from_fn(w, h, |x, y| image::Rgb([(x % 251) as u8, (y % 241) as u8, 90]));
    let mut out = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgb8(img).write_to(&mut out, image::ImageFormat::Jpeg).unwrap();
    out.into_inner()
}

#[tokio::test(flavor = "current_thread")]
async fn uploads_webp_by_default_keeps_the_original_and_numbers_clashes() {
    let Some(endpoint) = endpoint() else { return };
    // Arrange
    hexo_studio_lib::infra::install_tls();
    let blog = tempfile::tempdir().unwrap();
    let root = blog.path().join("EverettBlog");
    std::fs::create_dir(&root).unwrap();
    let backup = tempfile::tempdir().unwrap();
    let run = jiff::Timestamp::now().as_millisecond().to_string();
    let storage = Storage::S3 {
        bucket: "hexo-studio-test".into(),
        endpoint: endpoint.clone(),
        region: "us-east-1".into(),
        path: format!("t{run}/"),
        public_url: format!("{endpoint}/hexo-studio-test"),
    };
    keychain::save(&storage.credential_account(), &Credentials { access_key_id: "test".into(), access_key_secret: "test".into() }).unwrap();
    let settings = ProjectSettings { storage: Some(storage.clone()), ..ProjectSettings::default() };
    let photo = jpeg(3000, 2000);
    let now = jiff::civil::date(2025, 11, 24).at(1, 14, 20, 0);
    let upload = |name: Option<&str>, bytes: Vec<u8>, format| Upload {
        page: "pointer-security".into(),
        file_name: name.map(String::from),
        bytes,
        format,
    };

    // Act
    let first =
        images::upload(&root, &settings, backup.path(), upload(Some("IMG 1442.JPG"), photo.clone(), Format::Webp), now).await.unwrap();
    let second =
        images::upload(&root, &settings, backup.path(), upload(Some("IMG 1442.JPG"), photo.clone(), Format::Webp), now).await.unwrap();
    let original =
        images::upload(&root, &settings, backup.path(), upload(Some("IMG 1442.JPG"), photo.clone(), Format::Original), now).await.unwrap();
    let pasted = images::upload(&root, &settings, backup.path(), upload(None, jpeg(40, 30), Format::Webp), now).await.unwrap();

    // Assert: keys are <prefix><project>/<page>/<name>, numbered on clashes.
    let prefix = format!("t{run}/EverettBlog/pointer-security");
    assert_eq!(first.key, format!("{prefix}/IMG-1442.webp"));
    assert_eq!(second.key, format!("{prefix}/IMG-1442-2.webp"));
    assert_eq!(original.key, format!("{prefix}/IMG-1442.jpg"));
    assert_eq!(pasted.key, format!("{prefix}/image-20251124-011420.webp"));
    assert!(first.uploaded_bytes < first.original_bytes, "{} >= {}", first.uploaded_bytes, first.original_bytes);

    // Assert: the stored object is the WebP, scaled to 2560 px, at the public address.
    assert_eq!(first.url, format!("{endpoint}/hexo-studio-test/{prefix}/IMG-1442.webp"));
    let store = images::open_store(&settings).unwrap();
    let body = store.read(&first.key).await.unwrap();
    let served = image::load_from_memory(&body).unwrap();
    assert_eq!(image::guess_format(&body).unwrap(), image::ImageFormat::WebP);
    assert_eq!((served.width(), served.height()), (2560, 1707));
    assert_eq!(store.read(&original.key).await.unwrap(), photo);

    // Assert: the original is kept once, untouched, under <project>/<page>/.
    let kept = backup.path().join("EverettBlog/pointer-security/IMG-1442.jpg");
    assert_eq!(std::fs::read(&kept).unwrap(), photo);
    assert_eq!(first.backup, kept.display().to_string());
    assert_eq!(second.backup, first.backup);
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
    let storage = at("no-such-bucket-here");
    let store = hexo_studio_lib::infra::store::Store::open(
        &storage,
        &Credentials { access_key_id: "test".into(), access_key_secret: "test".into() },
    )
    .unwrap();

    let good = at("hexo-studio-test");
    let reachable =
        hexo_studio_lib::infra::store::Store::open(&good, &Credentials { access_key_id: "test".into(), access_key_secret: "test".into() })
            .unwrap();

    // Act
    let missing = store.check().await;
    let fine = reachable.check().await;

    // Assert
    assert!(missing.unwrap_err().contains("存储桶不存在"));
    assert_eq!(fine, Ok(()));
}

#[tokio::test(flavor = "current_thread")]
async fn old_images_move_under_their_first_page_and_the_blog_points_at_them() {
    let Some(endpoint) = endpoint() else { return };
    // Arrange: a blog whose images sit flat at the root of the store, as EverettBlog's do.
    hexo_studio_lib::infra::install_tls();
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("EverettBlog");
    let run = jiff::Timestamp::now().as_millisecond();
    let storage = Storage::S3 {
        bucket: "hexo-studio-test".into(),
        endpoint: endpoint.clone(),
        region: "us-east-1".into(),
        path: String::new(),
        public_url: format!("{endpoint}/hexo-studio-test"),
    };
    keychain::save(&storage.credential_account(), &Credentials { access_key_id: "test".into(), access_key_secret: "test".into() }).unwrap();
    let settings = ProjectSettings { storage: Some(storage.clone()), ..ProjectSettings::default() };
    let store = images::open_store(&settings).unwrap();
    let (photo, avatar, gif) = (format!("IMG_{run}.JPG"), format!("avatar-{run}.png"), format!("loading-{run}.gif"));
    store.put(&photo, jpeg(800, 600), "image/jpeg").await.unwrap();
    store.put(&avatar, jpeg(64, 64), "image/png").await.unwrap();
    store.put(&gif, b"GIF89a-not-really".to_vec(), "image/gif").await.unwrap();
    let base = storage.public_base();
    std::fs::create_dir_all(root.join("source/_posts")).unwrap();
    std::fs::write(root.join("_config.yml"), "timezone: Asia/Shanghai\n").unwrap();
    std::fs::write(root.join("package.json"), r#"{"dependencies":{"hexo":"^7"}}"#).unwrap();
    let early = format!(
        "---\ntitle: early\ndate: 2024-12-01 10:00:00\ncover: {base}/{photo}\n---\n![]({base}/{photo}?x-oss-process=image/resize,w_240)\n"
    );
    let later = format!("---\ntitle: later\ndate: 2025-01-01 10:00:00\n---\n![]({base}/{photo})  ![]({base}/{gif})\n");
    std::fs::write(root.join("source/_posts/early.md"), &early).unwrap();
    std::fs::write(root.join("source/_posts/later.md"), &later).unwrap();
    std::fs::write(root.join("_config.anzhiyu.yml"), format!("avatar:\n  img: {base}/{avatar} # keep this comment\n")).unwrap();
    let blog = hexo_studio_lib::infra::blog::open(&root).unwrap();
    let backup = tempfile::tempdir().unwrap();

    // Act
    let report = hexo_studio_lib::service::migration::run(&blog, &settings, backup.path(), |_| {}).await.unwrap();

    // Assert: every image moved, the photo under the post that used it first.
    assert!(report.failed.is_empty(), "{:?}", report.failed);
    let new_photo = format!("{base}/EverettBlog/early/IMG_{run}.webp");
    let new_gif = format!("{base}/EverettBlog/later/loading-{run}.gif");
    let new_avatar = format!("{base}/EverettBlog/_site/avatar-{run}.webp");
    assert_eq!(
        std::fs::read_to_string(root.join("source/_posts/early.md")).unwrap(),
        early.replace(&format!("{base}/{photo}"), &new_photo)
    );
    assert_eq!(
        std::fs::read_to_string(root.join("source/_posts/later.md")).unwrap(),
        later.replace(&format!("{base}/{photo}"), &new_photo).replace(&format!("{base}/{gif}"), &new_gif)
    );
    assert_eq!(
        std::fs::read_to_string(root.join("_config.anzhiyu.yml")).unwrap(),
        format!("avatar:\n  img: {new_avatar} # keep this comment\n")
    );
    let moved = store.read(&format!("EverettBlog/early/IMG_{run}.webp")).await.unwrap();
    assert_eq!(image::guess_format(&moved).unwrap(), image::ImageFormat::WebP);
    assert_eq!(store.read(&format!("EverettBlog/later/loading-{run}.gif")).await.unwrap(), b"GIF89a-not-really");

    // Assert: originals kept on this Mac; old objects still in the store.
    assert_eq!(std::fs::read(backup.path().join(format!("EverettBlog/early/IMG_{run}.jpg"))).unwrap(), jpeg(800, 600));
    assert!(store.exists(&photo).await.unwrap());

    // Act / Assert: nothing left to move.
    assert!(hexo_studio_lib::service::migration::plan(&blog, &settings).unwrap().is_empty());
}
