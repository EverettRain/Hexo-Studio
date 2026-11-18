//! Turning an image into the WebP that is uploaded: decode (respecting the camera's rotation),
//! scale down to the longest edge, encode lossy WebP.

use crate::domain::image_key::fit;
use image::{DynamicImage, ImageDecoder, ImageReader};
use std::io::Cursor;

pub struct Encoded {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

fn decode(bytes: &[u8]) -> Result<DynamicImage, String> {
    let mut decoder =
        ImageReader::new(Cursor::new(bytes)).with_guessed_format().map_err(|e| e.to_string())?.into_decoder().map_err(|e| e.to_string())?;
    let orientation = decoder.orientation().map_err(|e| e.to_string())?;
    let mut img = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    img.apply_orientation(orientation);
    Ok(img)
}

/// HEIC (iPhone photos) and other formats the decoder does not read are converted by macOS's
/// own `sips` first.
#[cfg(target_os = "macos")]
fn decode_with_sips(bytes: &[u8], ext: &str) -> Result<DynamicImage, String> {
    let dir = std::env::temp_dir().join(format!("hexo-studio-{}-{}", std::process::id(), jiff::Timestamp::now().as_nanosecond()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let input = dir.join(format!("in.{ext}"));
    let output = dir.join("out.png");
    let result = (|| {
        std::fs::write(&input, bytes).map_err(|e| e.to_string())?;
        let status = std::process::Command::new("/usr/bin/sips")
            .args(["-s", "format", "png"])
            .arg(&input)
            .arg("--out")
            .arg(&output)
            .output()
            .map_err(|e| e.to_string())?;
        if !status.status.success() {
            return Err(String::from_utf8_lossy(&status.stderr).trim().to_string());
        }
        decode(&std::fs::read(&output).map_err(|e| e.to_string())?)
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

#[cfg(not(target_os = "macos"))]
fn decode_with_sips(_bytes: &[u8], _ext: &str) -> Result<DynamicImage, String> {
    Err("不支持的图片格式".into())
}

pub fn to_webp(bytes: &[u8], ext: &str, quality: u8, max_edge: u32) -> Result<Encoded, String> {
    let img = decode(bytes).or_else(|first| decode_with_sips(bytes, ext).map_err(|_| format!("无法读取这张图片：{first}")))?;
    let (w, h) = fit(img.width(), img.height(), max_edge);
    let img = if (w, h) == (img.width(), img.height()) { img } else { img.resize_exact(w, h, image::imageops::FilterType::Lanczos3) };
    let img = if img.color().has_alpha() { DynamicImage::ImageRgba8(img.to_rgba8()) } else { DynamicImage::ImageRgb8(img.to_rgb8()) };
    let encoder = webp::Encoder::from_image(&img).map_err(|e| format!("无法编码 WebP：{e}"))?;
    let bytes = encoder.encode(quality.clamp(1, 100) as f32).to_vec();
    Ok(Encoded { bytes, width: w, height: h })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageFormat, Rgb, RgbImage, Rgba, RgbaImage};

    fn encoded(img: DynamicImage, format: ImageFormat) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, format).unwrap();
        out.into_inner()
    }

    #[test]
    fn a_large_jpeg_becomes_a_smaller_webp_within_the_edge() {
        // Arrange: a noisy photo-like image, 3000 × 2000.
        let img = RgbImage::from_fn(3000, 2000, |x, y| Rgb([(x % 251) as u8, (y % 241) as u8, ((x * y) % 239) as u8]));
        let jpeg = encoded(DynamicImage::ImageRgb8(img), ImageFormat::Jpeg);

        // Act
        let out = to_webp(&jpeg, "jpg", 82, 1500).unwrap();

        // Assert
        assert_eq!((out.width, out.height), (1500, 1000));
        assert_eq!(image::guess_format(&out.bytes).unwrap(), ImageFormat::WebP);
        let back = image::load_from_memory(&out.bytes).unwrap();
        assert_eq!((back.width(), back.height()), (1500, 1000));
    }

    #[test]
    fn transparency_survives() {
        // Arrange
        let img = RgbaImage::from_fn(64, 64, |x, _| Rgba([255, 0, 0, if x < 32 { 0 } else { 255 }]));
        let png = encoded(DynamicImage::ImageRgba8(img), ImageFormat::Png);

        // Act
        let out = to_webp(&png, "png", 82, 2560).unwrap();

        // Assert
        let back = image::load_from_memory(&out.bytes).unwrap().to_rgba8();
        assert!(back.get_pixel(4, 4)[3] < 16, "left half should stay transparent");
        assert!(back.get_pixel(60, 4)[3] > 240, "right half should stay opaque");
    }

    #[test]
    fn something_that_is_not_an_image_is_an_error() {
        // Act
        let r = to_webp(b"not an image", "jpg", 82, 2560);

        // Assert
        assert!(r.is_err());
    }
}
