//! The first start of a version with users, on a copy of a real data directory:
//! `HEXO_STUDIO_TEST_DATA=<copy of ~/Library/Application Support/Hexo-Studio> cargo test --test user_migration`.
//! Skipped without the variable. The copy is changed; never point it at the real directory.

use hexo_studio_lib::infra::{preferences, user};

#[test]
fn the_old_settings_become_the_first_users_preferences() {
    let Ok(dir) = std::env::var("HEXO_STUDIO_TEST_DATA") else {
        eprintln!("skipped: set HEXO_STUDIO_TEST_DATA");
        return;
    };
    // Arrange
    std::env::set_var("HEXO_STUDIO_HOME", &dir);
    let old: serde_json::Value = serde_json::from_slice(&std::fs::read(format!("{dir}/settings.json")).unwrap()).unwrap();

    // Act
    let prefs = preferences::load();
    let profile = user::profile().unwrap();
    let saved = preferences::update(|p| p.ui.preview_share = Some(0.4)).unwrap();

    // Assert
    assert_eq!(prefs.recent.len(), old["recent"].as_array().unwrap().len());
    assert_eq!(prefs.recent[0].path, old["recent"][0]["path"].as_str().unwrap());
    assert!(!profile.name.is_empty());
    assert_eq!(saved.recent, prefs.recent);
    assert_eq!(preferences::load().ui.preview_share, Some(0.4));
    eprintln!("user: {}; data dir now: {:?}", profile.name, std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name()).collect::<Vec<_>>());
}
