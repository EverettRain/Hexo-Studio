//! The project's image library (`.hexostudio/images.json`): one record per image, with every
//! column of the user's image checklist, and how the checklist CSV is read and written.

use super::image_key::Format;
use serde::{Deserialize, Serialize};

/// A copy of the image on another image host; only recorded, never uploaded by the app.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mirror {
    /// The host, e.g. `聚合图床`, `Hello Image`.
    pub label: String,
    pub url: String,
    /// `YYYY-MM-DD`; empty when unknown.
    #[serde(default)]
    pub date: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Original {
    pub file_name: String,
    pub bytes: u64,
    /// The kept original, relative to the backup folder.
    pub backup: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    /// Content hash of the original (see `image_key::content_id`).
    pub id: String,
    /// 图片名称.
    pub name: String,
    /// 图片位置描述, written by hand.
    #[serde(default)]
    pub description: String,
    /// 是否正常, marked by hand; `None` when never marked.
    #[serde(default)]
    pub ok: Option<bool>,
    /// Object key in the store.
    pub key: String,
    pub url: String,
    /// 上传日期, `YYYY-MM-DD`.
    #[serde(default)]
    pub uploaded_at: String,
    #[serde(default)]
    pub mirrors: Vec<Mirror>,
    pub format: Format,
    #[serde(default)]
    pub bytes: u64,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub original: Original,
    /// Addresses the image had before it was taken into the library.
    #[serde(default)]
    pub legacy_urls: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    pub version: u32,
    pub images: Vec<Image>,
}

impl Default for Catalog {
    fn default() -> Self {
        Catalog { version: 1, images: Vec::new() }
    }
}

impl Catalog {
    pub fn get(&self, id: &str) -> Option<&Image> {
        self.images.iter().find(|i| i.id == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Image> {
        self.images.iter_mut().find(|i| i.id == id)
    }

    /// The image an address names: its own, or one it had before.
    pub fn by_url(&self, url: &str) -> Option<&Image> {
        self.images.iter().find(|i| i.url == url || i.legacy_urls.iter().any(|u| u == url))
    }

    pub fn by_key(&self, key: &str) -> Option<&Image> {
        self.images.iter().find(|i| i.key == key)
    }

    /// Adds an image unless one with its uid is there; returns whether it was added.
    pub fn add(&mut self, image: Image) -> bool {
        if self.get(&image.id).is_some() {
            return false;
        }
        self.images.push(image);
        true
    }

    pub fn remove(&mut self, id: &str) -> Option<Image> {
        let i = self.images.iter().position(|x| x.id == id)?;
        Some(self.images.remove(i))
    }
}

/// `2025.3.4`, `2025/4/20`, `2025-04-20` → `2025-03-04`, `2025-04-20`; anything else as written.
pub fn normalize_date(raw: &str) -> String {
    let t = raw.trim();
    let parts: Vec<&str> = t.split(['.', '/', '-']).collect();
    match parts.as_slice() {
        [y, m, d] if y.len() == 4 && [y, m, d].iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit())) => {
            format!("{y}-{:0>2}-{:0>2}", m, d)
        }
        _ => t.to_string(),
    }
}

/// One row of the checklist: what the user kept by hand for each image.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChecklistRow {
    pub ok: Option<bool>,
    pub name: String,
    pub description: String,
    /// The image's address in the store (the 阿里云 OSS 图床 column).
    pub url: String,
    pub date: String,
    pub mirrors: Vec<Mirror>,
}

const HEADER: [&str; 8] = [
    "是否正常",
    "图片名称",
    "图片位置描述",
    "阿里云 OSS 图床",
    "上传日期",
    "聚合图床 www.superbed.cn URL",
    "上传日期",
    "Hello Image 图床 helloimg.com URL",
];
const MIRROR_LABELS: [&str; 2] = ["聚合图床", "Hello Image"];

fn bool_cell(s: &str) -> Option<bool> {
    match s.trim().to_ascii_uppercase().as_str() {
        "TRUE" | "是" | "✓" | "YES" => Some(true),
        "FALSE" | "否" | "✗" | "NO" => Some(false),
        _ => None,
    }
}

/// Reads the checklist as the user's spreadsheet exports it: an optional title line, the header
/// row (`是否正常,图片名称,…`), then one image per row. Rows without an address are skipped.
pub fn parse_checklist(text: &str) -> Result<Vec<ChecklistRow>, String> {
    let mut reader =
        csv::ReaderBuilder::new().has_headers(false).flexible(true).from_reader(text.trim_start_matches('\u{feff}').as_bytes());
    let mut rows = Vec::new();
    let mut seen_header = false;
    for rec in reader.records() {
        let rec = rec.map_err(|e| format!("清单 CSV 格式有误：{e}"))?;
        let cell = |i: usize| rec.get(i).unwrap_or("").trim().to_string();
        if !seen_header {
            seen_header = cell(0) == HEADER[0] && cell(1) == HEADER[1];
            continue;
        }
        let url = cell(3);
        if url.is_empty() {
            continue;
        }
        // The checklist dates the 聚合图床 copy (column 6) but not the Hello Image one.
        let mut mirrors = Vec::new();
        if !cell(5).is_empty() {
            mirrors.push(Mirror { label: MIRROR_LABELS[0].into(), url: cell(5), date: normalize_date(&cell(6)) });
        }
        if !cell(7).is_empty() {
            mirrors.push(Mirror { label: MIRROR_LABELS[1].into(), url: cell(7), date: String::new() });
        }
        rows.push(ChecklistRow {
            ok: bool_cell(&cell(0)),
            name: cell(1),
            description: cell(2),
            url,
            date: normalize_date(&cell(4)),
            mirrors,
        });
    }
    if !seen_header {
        return Err("没有找到清单的表头（是否正常,图片名称,图片位置描述,…）。".into());
    }
    Ok(rows)
}

/// Copies what the checklist knows into an image; the image's own address and uid stay.
pub fn apply_row(image: &mut Image, row: &ChecklistRow) {
    if !row.name.is_empty() {
        image.name = row.name.clone();
    }
    if !row.description.is_empty() {
        image.description = row.description.clone();
    }
    if row.ok.is_some() {
        image.ok = row.ok;
    }
    if !row.date.is_empty() {
        image.uploaded_at = row.date.clone();
    }
    for m in &row.mirrors {
        match image.mirrors.iter_mut().find(|x| x.label == m.label) {
            Some(x) => *x = m.clone(),
            None => image.mirrors.push(m.clone()),
        }
    }
}

/// The library as a checklist CSV, in the user's columns plus the app's: uid, format, size,
/// and the pages that use each image. Opens in Numbers / Excel (UTF-8 with BOM).
pub fn export_checklist(catalog: &Catalog, used_by: impl Fn(&str) -> Vec<String>) -> String {
    let mut w = csv::WriterBuilder::new().terminator(csv::Terminator::CRLF).from_writer(Vec::new());
    let mut header: Vec<&str> = HEADER.to_vec();
    header.extend(["uid", "格式", "大小（字节）", "宽", "高", "使用页面"]);
    let _ = w.write_record(&header);
    for i in &catalog.images {
        let mirror = |label: &str| i.mirrors.iter().find(|m| m.label == label).map(|m| (m.url.clone(), m.date.clone())).unwrap_or_default();
        let (sb, sb_date) = mirror(MIRROR_LABELS[0]);
        let (hello, _) = mirror(MIRROR_LABELS[1]);
        let ok = match i.ok {
            Some(true) => "TRUE",
            Some(false) => "FALSE",
            None => "",
        };
        let format = match i.format {
            Format::Webp => "webp",
            Format::Original => "原图",
        };
        let record = [
            ok.to_string(),
            i.name.clone(),
            i.description.clone(),
            i.url.clone(),
            i.uploaded_at.clone(),
            sb,
            sb_date,
            hello,
            i.id.clone(),
            format.to_string(),
            i.bytes.to_string(),
            i.width.to_string(),
            i.height.to_string(),
            used_by(&i.id).join(" / "),
        ];
        let _ = w.write_record(&record);
    }
    let body = String::from_utf8(w.into_inner().unwrap_or_default()).unwrap_or_default();
    format!("\u{feff}{body}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(id: &str) -> Image {
        Image {
            id: id.into(),
            name: "n".into(),
            description: String::new(),
            ok: None,
            key: format!("Blog/{id}.webp"),
            url: format!("https://cdn/Blog/{id}.webp"),
            uploaded_at: "2025-11-24".into(),
            mirrors: vec![],
            format: Format::Webp,
            bytes: 1,
            width: 1,
            height: 1,
            original: Original::default(),
            legacy_urls: vec!["https://cdn/old.jpg".into()],
        }
    }

    /// The first lines of the user's checklist, as exported (CRLF, title line, header row).
    const CHECKLIST: &str = "Hexo 网站图片核对清单\r\n\
是否正常,图片名称,图片位置描述,阿里云 OSS 图床,上传日期,聚合图床 www.superbed.cn URL,上传日期,Hello Image 图床 helloimg.com URL\r\n\
TRUE,IMG 0782 compressed,网站头图 top_img 和背景 background,https://hexo-image-storage.oss-cn-shanghai.aliyuncs.com/IMG_0782_compressed.JPG,2025.3.4,https://pic1.imgdb.cn/item/678ca021d0e0a243d4f59c32.jpg,2025.1.19,https://www.helloimg.com/i/2025/01/19/678c97f16b412.jpg\r\n\
FALSE,main_bg compressed,网站头图 top_img 和背景 background,https://hexo-image-storage.oss-cn-shanghai.aliyuncs.com/main_bg_compressed.JPG,2025/4/21,,,\r\n\
,,,,,,,\r\n";

    #[test]
    fn reads_the_users_checklist() {
        // Act
        let rows = parse_checklist(CHECKLIST).unwrap();

        // Assert
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0],
            ChecklistRow {
                ok: Some(true),
                name: "IMG 0782 compressed".into(),
                description: "网站头图 top_img 和背景 background".into(),
                url: "https://hexo-image-storage.oss-cn-shanghai.aliyuncs.com/IMG_0782_compressed.JPG".into(),
                date: "2025-03-04".into(),
                mirrors: vec![
                    Mirror {
                        label: "聚合图床".into(),
                        url: "https://pic1.imgdb.cn/item/678ca021d0e0a243d4f59c32.jpg".into(),
                        date: "2025-01-19".into()
                    },
                    Mirror {
                        label: "Hello Image".into(),
                        url: "https://www.helloimg.com/i/2025/01/19/678c97f16b412.jpg".into(),
                        date: String::new()
                    },
                ],
            }
        );
        assert_eq!((rows[1].ok, rows[1].date.as_str(), rows[1].mirrors.len()), (Some(false), "2025-04-21", 0));
    }

    #[test]
    fn a_file_without_the_header_is_refused() {
        // Act / Assert
        assert!(parse_checklist("a,b,c\r\n1,2,3\r\n").is_err());
    }

    #[test]
    fn dates_are_normalized_and_others_kept() {
        // Act / Assert
        assert_eq!(normalize_date("2025.3.4"), "2025-03-04");
        assert_eq!(normalize_date("2025/4/20"), "2025-04-20");
        assert_eq!(normalize_date("2025-04-20"), "2025-04-20");
        assert_eq!(normalize_date("去年春天"), "去年春天");
        assert_eq!(normalize_date(""), "");
    }

    #[test]
    fn a_row_fills_the_hand_kept_fields_and_keeps_the_address() {
        // Arrange
        let mut img = image("aaa");
        let row = parse_checklist(CHECKLIST).unwrap().remove(0);

        // Act
        apply_row(&mut img, &row);

        // Assert
        assert_eq!((img.name.as_str(), img.ok, img.uploaded_at.as_str()), ("IMG 0782 compressed", Some(true), "2025-03-04"));
        assert_eq!(img.mirrors.len(), 2);
        assert_eq!(img.url, "https://cdn/Blog/aaa.webp");
    }

    #[test]
    fn images_are_found_by_uid_address_or_former_address_and_added_once() {
        // Arrange
        let mut c = Catalog::default();

        // Act
        let first = c.add(image("aaa"));
        let again = c.add(image("aaa"));

        // Assert
        assert!(first && !again);
        assert_eq!(c.images.len(), 1);
        assert!(c.by_url("https://cdn/Blog/aaa.webp").is_some());
        assert!(c.by_url("https://cdn/old.jpg").is_some());
        assert!(c.by_key("Blog/aaa.webp").is_some());
        assert!(c.remove("aaa").is_some() && c.images.is_empty());
    }

    #[test]
    fn the_export_reads_back_as_a_checklist() {
        // Arrange
        let mut img = image("aaa");
        img.ok = Some(true);
        img.name = "名, with comma".into();
        img.mirrors = vec![Mirror { label: "聚合图床".into(), url: "https://pic1/x.jpg".into(), date: "2025-01-19".into() }];
        let catalog = Catalog { version: 1, images: vec![img] };

        // Act
        let csv = export_checklist(&catalog, |_| vec!["source/_posts/a.md".into()]);
        let rows = parse_checklist(&csv).unwrap();

        // Assert
        assert!(csv.starts_with('\u{feff}'));
        assert!(csv.contains("source/_posts/a.md"));
        assert_eq!(rows[0].name, "名, with comma");
        assert_eq!(rows[0].url, "https://cdn/Blog/aaa.webp");
        assert_eq!(rows[0].mirrors[0].date, "2025-01-19");
    }
}
