//! The object store a project's images go to, through Apache OpenDAL (it signs the requests of
//! each provider; nothing here knows a signature scheme).

use super::keychain::Credentials;
use crate::domain::storage::Storage;
use opendal::layers::{RetryLayer, TimeoutLayer};
use opendal::{services, ErrorKind, Operator};
use std::time::Duration;

pub struct Store {
    op: Operator,
}

/// The store's own error code (S3 and OSS share these names) says more than OpenDAL's kind.
fn readable(e: opendal::Error) -> String {
    let detail = format!("{e:?}");
    let has = |code: &str| detail.contains(&format!("\"{code}\""));
    if has("NoSuchBucket") {
        format!("存储桶不存在，请检查桶名和地域。（{e}）")
    } else if has("InvalidAccessKeyId") || has("SignatureDoesNotMatch") {
        format!("AccessKey ID 或 Secret 不对。（{e}）")
    } else {
        match e.kind() {
            ErrorKind::PermissionDenied => format!("存储拒绝了请求，请检查 AccessKey 与存储桶权限。（{e}）"),
            ErrorKind::NotFound => format!("找不到存储桶或对象。（{e}）"),
            ErrorKind::ConfigInvalid => format!("存储设置有误：{e}"),
            _ => format!("访问存储失败：{e}"),
        }
    }
}

/// OpenDAL sends its requests through a process-wide transport, installed once.
fn install_transport() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        super::install_tls();
        opendal::HttpTransporter::install_default(opendal_http_transport_reqwest::ReqwestTransport::new(reqwest::Client::new()));
    });
}

impl Store {
    pub fn open(storage: &Storage, c: &Credentials) -> Result<Store, String> {
        storage.validate()?;
        install_transport();
        let endpoint = storage.endpoint();
        let op = match storage {
            Storage::AliyunOss { .. } => Operator::new(
                services::Oss::default()
                    .root("/")
                    .bucket(storage.bucket())
                    .endpoint(&endpoint)
                    .access_key_id(&c.access_key_id)
                    .access_key_secret(&c.access_key_secret),
            ),
            Storage::S3 { region, .. } => Operator::new(
                services::S3::default()
                    .root("/")
                    .bucket(storage.bucket())
                    .endpoint(&endpoint)
                    .region(if region.trim().is_empty() { "auto" } else { region.trim() })
                    .access_key_id(&c.access_key_id)
                    .secret_access_key(&c.access_key_secret)
                    // Only the keys given here: not ~/.aws or the environment.
                    .disable_config_load(),
            ),
        }
        .map_err(readable)?
        .layer(TimeoutLayer::new().with_timeout(Duration::from_secs(60)))
        .layer(RetryLayer::new().with_max_times(3));
        Ok(Store { op })
    }

    pub async fn exists(&self, key: &str) -> Result<bool, String> {
        self.op.exists(key).await.map_err(readable)
    }

    pub async fn put(&self, key: &str, bytes: Vec<u8>, content_type: &str) -> Result<(), String> {
        self.op.write_with(key, bytes).content_type(content_type).await.map(|_| ()).map_err(readable)
    }

    pub async fn read(&self, key: &str) -> Result<Vec<u8>, String> {
        self.op.read(key).await.map(|b| b.to_vec()).map_err(readable)
    }

    pub async fn delete(&self, key: &str) -> Result<(), String> {
        self.op.delete(key).await.map_err(readable)
    }

    /// Checks the bucket answers with these keys, without writing anything: lists a folder that
    /// does not exist, which a reachable bucket answers with nothing (a missing bucket with
    /// NoSuchBucket, wrong keys with a refusal).
    pub async fn check(&self) -> Result<(), String> {
        self.op.list("hexostudio-connection-check/").await.map(|_| ()).map_err(readable)
    }
}
