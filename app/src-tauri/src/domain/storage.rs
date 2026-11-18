//! Where a project's images go: one of the object stores the app supports, with the fields
//! PicGo uses for it (bucket, area, path, customUrl), so a PicGo setup carries over.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum Storage {
    /// Aliyun OSS, through its own API.
    AliyunOss {
        bucket: String,
        /// The region as PicGo writes it, e.g. `oss-cn-shanghai`.
        area: String,
        /// Prefix of every object key, e.g. `img/`; may be empty.
        #[serde(default)]
        path: String,
        /// A custom domain bound to the bucket, e.g. `https://img.example.com`; empty for the
        /// bucket's own address.
        #[serde(default)]
        custom_url: String,
    },
    /// Any S3-compatible store: Qiniu Kodo, Cloudflare R2, AWS S3, MinIO, ...
    S3 {
        bucket: String,
        /// API address, e.g. `https://s3.cn-east-1.qiniucs.com`.
        endpoint: String,
        #[serde(default)]
        region: String,
        #[serde(default)]
        path: String,
        /// Public address of the bucket's objects, e.g. `https://img.example.com`.
        public_url: String,
    },
}

fn trimmed(s: &str) -> &str {
    s.trim()
}

/// `img`, `/img/`, `img//` → `img/`; empty stays empty.
fn normalized_prefix(path: &str) -> String {
    let inner: Vec<&str> = path.split('/').map(str::trim).filter(|p| !p.is_empty()).collect();
    if inner.is_empty() {
        String::new()
    } else {
        format!("{}/", inner.join("/"))
    }
}

/// Percent-encodes each segment of a key for use in a URL; `/` separates segments.
pub fn encode_key(key: &str) -> String {
    key.split('/')
        .map(|seg| url::form_urlencoded::byte_serialize(seg.as_bytes()).collect::<String>().replace('+', "%20"))
        .collect::<Vec<_>>()
        .join("/")
}

impl Storage {
    pub fn bucket(&self) -> &str {
        match self {
            Storage::AliyunOss { bucket, .. } | Storage::S3 { bucket, .. } => trimmed(bucket),
        }
    }

    /// `oss-cn-shanghai`, also accepted without the `oss-` PicGo always writes.
    fn area(&self) -> Option<String> {
        match self {
            Storage::AliyunOss { area, .. } => {
                let a = area.trim();
                Some(if a.starts_with("oss-") { a.to_string() } else { format!("oss-{a}") })
            }
            Storage::S3 { .. } => None,
        }
    }

    /// The API address the client talks to.
    pub fn endpoint(&self) -> String {
        match self {
            Storage::AliyunOss { .. } => format!("https://{}.aliyuncs.com", self.area().unwrap_or_default()),
            Storage::S3 { endpoint, .. } => endpoint.trim().trim_end_matches('/').to_string(),
        }
    }

    /// Prefix of every key the app writes, ending in `/` unless empty.
    pub fn prefix(&self) -> String {
        match self {
            Storage::AliyunOss { path, .. } | Storage::S3 { path, .. } => normalized_prefix(path),
        }
    }

    /// Where the objects are read from on the web, without a trailing slash.
    pub fn public_base(&self) -> String {
        match self {
            Storage::AliyunOss { custom_url, .. } if !custom_url.trim().is_empty() => custom_url.trim().trim_end_matches('/').to_string(),
            Storage::AliyunOss { .. } => format!("https://{}.{}.aliyuncs.com", self.bucket(), self.area().unwrap_or_default()),
            Storage::S3 { public_url, .. } => public_url.trim().trim_end_matches('/').to_string(),
        }
    }

    pub fn public_url(&self, key: &str) -> String {
        format!("{}/{}", self.public_base(), encode_key(key))
    }

    /// Names the credentials in the keychain: one entry per store and bucket.
    pub fn credential_account(&self) -> String {
        match self {
            Storage::AliyunOss { .. } => format!("aliyun-oss:{}", self.bucket()),
            Storage::S3 { .. } => format!("s3:{}@{}", self.bucket(), self.endpoint()),
        }
    }

    /// What is missing or malformed, in the interface's words.
    pub fn validate(&self) -> Result<(), String> {
        let url_ok = |u: &str| u.starts_with("https://") || u.starts_with("http://");
        if self.bucket().is_empty() {
            return Err("请填写存储桶名称。".into());
        }
        match self {
            Storage::AliyunOss { area, custom_url, .. } => {
                if area.trim().is_empty() {
                    return Err("请填写地域，例如 oss-cn-shanghai。".into());
                }
                if !custom_url.trim().is_empty() && !url_ok(custom_url.trim()) {
                    return Err("自定义域名要以 https:// 或 http:// 开头。".into());
                }
            }
            Storage::S3 { endpoint, public_url, .. } => {
                if !url_ok(endpoint.trim()) {
                    return Err("请填写以 https:// 开头的 API 地址（endpoint）。".into());
                }
                if !url_ok(public_url.trim()) {
                    return Err("请填写以 https:// 开头的公开访问地址。".into());
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn aliyun(path: &str, custom_url: &str) -> Storage {
        Storage::AliyunOss {
            bucket: "hexo-image-storage".into(),
            area: "oss-cn-shanghai".into(),
            path: path.into(),
            custom_url: custom_url.into(),
        }
    }

    #[test]
    fn aliyun_addresses_follow_bucket_and_area() {
        // Arrange
        let s = aliyun("", "");

        // Act / Assert
        assert_eq!(s.endpoint(), "https://oss-cn-shanghai.aliyuncs.com");
        assert_eq!(s.public_url("EverettBlog/a/b.webp"), "https://hexo-image-storage.oss-cn-shanghai.aliyuncs.com/EverettBlog/a/b.webp");
    }

    #[test]
    fn an_area_without_the_oss_prefix_is_accepted() {
        // Arrange
        let s = Storage::AliyunOss { bucket: "b".into(), area: "cn-shanghai".into(), path: String::new(), custom_url: String::new() };

        // Act / Assert
        assert_eq!(s.endpoint(), "https://oss-cn-shanghai.aliyuncs.com");
    }

    #[test]
    fn a_custom_domain_replaces_the_bucket_address() {
        // Arrange
        let s = aliyun("", "https://img.example.com/");

        // Act / Assert
        assert_eq!(s.public_url("x.webp"), "https://img.example.com/x.webp");
    }

    #[test]
    fn key_segments_are_percent_encoded_and_slashes_kept() {
        // Arrange
        let s = aliyun("", "");

        // Act
        let url = s.public_url("EverettBlog/搭建Hexo博客网站教程/图 1.webp");

        // Assert
        assert_eq!(
            url,
            "https://hexo-image-storage.oss-cn-shanghai.aliyuncs.com/EverettBlog/%E6%90%AD%E5%BB%BAHexo%E5%8D%9A%E5%AE%A2%E7%BD%91%E7%AB%99%E6%95%99%E7%A8%8B/%E5%9B%BE%201.webp"
        );
    }

    #[test]
    fn the_prefix_is_normalized_to_a_trailing_slash() {
        // Act / Assert
        assert_eq!(aliyun("/img//2025/", "").prefix(), "img/2025/");
        assert_eq!(aliyun("  ", "").prefix(), "");
    }

    #[test]
    fn s3_uses_the_given_endpoint_and_public_address() {
        // Arrange
        let s = Storage::S3 {
            bucket: "blog".into(),
            endpoint: "https://s3.cn-east-1.qiniucs.com/".into(),
            region: "cn-east-1".into(),
            path: "img".into(),
            public_url: "https://img.example.com".into(),
        };

        // Act / Assert
        assert_eq!(s.endpoint(), "https://s3.cn-east-1.qiniucs.com");
        assert_eq!(s.public_url("img/a.webp"), "https://img.example.com/img/a.webp");
        assert_eq!(s.credential_account(), "s3:blog@https://s3.cn-east-1.qiniucs.com");
    }

    #[test]
    fn credentials_are_kept_per_bucket() {
        // Act / Assert
        assert_eq!(aliyun("", "").credential_account(), "aliyun-oss:hexo-image-storage");
    }

    #[test]
    fn missing_fields_are_explained() {
        // Arrange
        let no_bucket =
            Storage::AliyunOss { bucket: " ".into(), area: "oss-cn-shanghai".into(), path: String::new(), custom_url: String::new() };
        let bad_domain = aliyun("", "img.example.com");
        let no_public = Storage::S3 {
            bucket: "b".into(),
            endpoint: "https://e".into(),
            region: String::new(),
            path: String::new(),
            public_url: String::new(),
        };

        // Act / Assert
        assert!(no_bucket.validate().unwrap_err().contains("存储桶"));
        assert!(bad_domain.validate().unwrap_err().contains("自定义域名"));
        assert!(no_public.validate().unwrap_err().contains("公开访问地址"));
        assert!(aliyun("img", "").validate().is_ok());
    }

    #[test]
    fn reads_the_interfaces_json() {
        // Act
        let s: Storage = serde_json::from_str(r#"{"kind":"aliyunOss","bucket":"b","area":"oss-cn-shanghai","customUrl":""}"#).unwrap();

        // Assert
        assert_eq!(
            s,
            Storage::AliyunOss { bucket: "b".into(), area: "oss-cn-shanghai".into(), path: String::new(), custom_url: String::new() }
        );
    }
}
