//! A post's address on the site, as Hexo computes it.
//!
//! Hexo reads a front-matter date without an offset in the blog's `timezone`, then formats the
//! address parts in the zone of the process running it. The app runs Hexo with `TZ` set to the
//! blog's zone (see `infra::hexo`), so both are the blog's zone and the address follows from
//! the date as written. Formatting in UTC instead moves posts written between 0:00 and 8:00
//! (Asia/Shanghai) to the day before.

use super::post::Meta;
use jiff::civil::{Date, DateTime};
use jiff::tz::TimeZone;
use jiff::{Timestamp, ZonedDateTime as Zoned};

/// The moment a front-matter date stands for. A date with an offset (`2025-11-24T01:14:20+08:00`,
/// `...Z`) is that instant; one without is wall-clock time in `tz`. `None` when unreadable.
pub fn post_date(raw: &str, tz: &TimeZone) -> Option<Zoned> {
    let s = raw.trim().replace('/', "-");
    if let Ok(t) = s.parse::<Timestamp>() {
        return Some(t.to_zoned_datetime(tz.clone()));
    }
    let civil = s.parse::<DateTime>().ok().or_else(|| s.parse::<Date>().ok().map(|d| d.to_datetime(jiff::civil::Time::midnight())))?;
    tz.to_ambiguous_zoned_datetime(civil).compatible().ok()
}

/// The zone named in `_config.yml`, else the machine's (as Hexo does).
pub fn blog_zone(name: Option<&str>) -> TimeZone {
    name.and_then(|n| TimeZone::get(n).ok()).unwrap_or_else(TimeZone::system)
}

/// The path of a post under the site root, e.g. `2025/11/24/pointer-security/`, from the
/// `permalink` pattern. `None` when the pattern uses a part this does not know (`:hash`,
/// `:category`, ...): the caller then falls back to the home page instead of guessing.
pub fn path(pattern: &str, slug: &str, date: &Zoned) -> Option<String> {
    let name = slug.rsplit('/').next().unwrap_or(slug);
    let value = |token: &str| -> Option<String> {
        Some(match token {
            "year" => format!("{:04}", date.year()),
            "month" => format!("{:02}", date.month()),
            "day" => format!("{:02}", date.day()),
            "hour" => format!("{:02}", date.hour()),
            "minute" => format!("{:02}", date.minute()),
            "second" => format!("{:02}", date.second()),
            "i_month" => date.month().to_string(),
            "i_day" => date.day().to_string(),
            "title" => slug.to_string(),
            "name" => name.to_string(),
            _ => return None,
        })
    };
    let mut out = String::new();
    let mut rest = pattern.trim_start_matches('/');
    while let Some(at) = rest.find(':') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let len = after.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_')).unwrap_or(after.len());
        if len == 0 {
            out.push(':');
        } else {
            out.push_str(&value(&after[..len])?);
        }
        rest = &after[len..];
    }
    out.push_str(rest);
    Some(out)
}

/// A per-post `permalink` from front-matter, used as written but without a leading slash.
pub fn explicit(permalink: &str) -> String {
    permalink.trim().trim_start_matches('/').to_string()
}

/// A post's path under the site root. Without a `date` Hexo dates the post by the file's
/// creation time (`created`); with one it cannot read, there is no address.
pub fn for_post(meta: &Meta, slug: &str, pattern: &str, tz: &TimeZone, created: Timestamp) -> Option<String> {
    if let Some(p) = &meta.permalink {
        return Some(explicit(p));
    }
    let date = match &meta.date {
        Some(raw) => post_date(raw, tz)?,
        None => created.to_zoned_datetime(tz.clone()),
    };
    path(pattern, slug, &date)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLOG: &str = ":year/:month/:day/:title/";

    fn shanghai() -> TimeZone {
        TimeZone::get("Asia/Shanghai").unwrap()
    }

    #[test]
    fn early_morning_posts_keep_their_written_day() {
        // Arrange: 01:14 in Shanghai is still the 23rd in UTC.
        let date = post_date("2025-11-24 01:14:20", &shanghai()).unwrap();

        // Act
        let p = path(BLOG, "pointer-security", &date);

        // Assert
        assert_eq!(p.as_deref(), Some("2025/11/24/pointer-security/"));
    }

    #[test]
    fn the_written_time_is_read_in_the_blogs_zone() {
        // Act
        let date = post_date("2025-11-24 01:14:20", &shanghai()).unwrap();

        // Assert
        assert_eq!(date.timestamp(), "2025-11-23T17:14:20Z".parse::<Timestamp>().unwrap());
    }

    #[test]
    fn a_date_with_an_offset_is_moved_into_the_blogs_zone() {
        // Arrange: 20:00 UTC on the 23rd is 04:00 on the 24th in Shanghai.
        let date = post_date("2025-11-23T20:00:00Z", &shanghai()).unwrap();

        // Act
        let p = path(BLOG, "a", &date);

        // Assert
        assert_eq!(p.as_deref(), Some("2025/11/24/a/"));
    }

    #[test]
    fn date_only_slashes_t_separator_and_minutes_only_are_accepted() {
        // Arrange
        let inputs = ["2025-02-03", "2025/02/03 11:34:23", "2025-02-03T11:34:23", "2025-02-03 11:34"];

        for raw in inputs {
            // Act
            let date = post_date(raw, &shanghai());

            // Assert
            assert_eq!(date.map(|d| d.date()), Some(jiff::civil::date(2025, 2, 3)), "{raw}");
        }
    }

    #[test]
    fn unreadable_dates_are_none() {
        // Act / Assert
        assert!(post_date("yesterday", &shanghai()).is_none());
        assert!(post_date("", &shanghai()).is_none());
    }

    #[test]
    fn all_date_parts_and_unpadded_month_and_day() {
        // Arrange
        let date = post_date("2025-02-03 04:05:06", &shanghai()).unwrap();

        // Act
        let p = path(":year-:month-:day-:hour-:minute-:second/:i_month/:i_day/:title.html", "x", &date);

        // Assert
        assert_eq!(p.as_deref(), Some("2025-02-03-04-05-06/2/3/x.html"));
    }

    #[test]
    fn name_is_the_last_folder_level_of_the_slug_and_title_keeps_it_whole() {
        // Arrange
        let date = post_date("2025-02-03", &shanghai()).unwrap();

        // Act
        let p = path(":name/:title/", "notes/c1", &date);

        // Assert
        assert_eq!(p.as_deref(), Some("c1/notes/c1/"));
    }

    #[test]
    fn unknown_parts_give_no_address() {
        // Arrange
        let date = post_date("2025-02-03", &shanghai()).unwrap();

        // Act / Assert
        assert_eq!(path(":category/:title/", "x", &date), None);
        assert_eq!(path("posts/:abbrlink.html", "x", &date), None);
    }

    #[test]
    fn a_leading_slash_and_a_lone_colon_are_kept_out_and_in() {
        // Arrange
        let date = post_date("2025-02-03", &shanghai()).unwrap();

        // Act
        let p = path("/a:/:title", "x", &date);

        // Assert
        assert_eq!(p.as_deref(), Some("a:/x"));
    }

    #[test]
    fn an_explicit_permalink_loses_its_leading_slash() {
        // Act / Assert
        assert_eq!(explicit(" /about/me/ "), "about/me/");
    }

    #[test]
    fn a_post_uses_its_written_date() {
        // Arrange
        let meta = Meta { date: Some("2025-09-07 00:29:46".into()), ..Meta::default() };
        let created = "2020-01-01T00:00:00Z".parse().unwrap();

        // Act
        let p = for_post(&meta, "nuaa-movie-resources", BLOG, &shanghai(), created);

        // Assert
        assert_eq!(p.as_deref(), Some("2025/09/07/nuaa-movie-resources/"));
    }

    #[test]
    fn a_post_without_a_date_is_dated_by_file_creation_in_the_blogs_zone() {
        // Arrange: 18:00 UTC is 02:00 the next day in Shanghai.
        let created = "2025-09-06T18:00:00Z".parse().unwrap();

        // Act
        let p = for_post(&Meta::default(), "draft", BLOG, &shanghai(), created);

        // Assert
        assert_eq!(p.as_deref(), Some("2025/09/07/draft/"));
    }

    #[test]
    fn a_per_post_permalink_wins_and_an_unreadable_date_gives_none() {
        // Arrange
        let created = Timestamp::UNIX_EPOCH;
        let explicit = Meta { permalink: Some("/about/".into()), date: Some("bad".into()), ..Meta::default() };
        let unreadable = Meta { date: Some("bad".into()), ..Meta::default() };

        // Act / Assert
        assert_eq!(for_post(&explicit, "x", BLOG, &shanghai(), created).as_deref(), Some("about/"));
        assert_eq!(for_post(&unreadable, "x", BLOG, &shanghai(), created), None);
    }

    #[test]
    fn the_configured_zone_is_used_and_an_unknown_one_falls_back_to_the_machines() {
        // Act / Assert
        assert_eq!(blog_zone(Some("Asia/Shanghai")).iana_name(), Some("Asia/Shanghai"));
        assert_eq!(blog_zone(Some("Mars/Base")), TimeZone::system());
        assert_eq!(blog_zone(None), TimeZone::system());
    }
}
