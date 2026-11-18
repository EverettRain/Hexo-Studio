//! Storage credentials, kept in the macOS keychain (never in a settings file).

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credentials {
    pub access_key_id: String,
    pub access_key_secret: String,
}

#[cfg(target_os = "macos")]
mod store {
    const SERVICE: &str = "Hexo-Studio";

    fn entry(account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, account).map_err(|e| format!("无法访问钥匙串：{e}"))
    }

    pub fn get(account: &str) -> Result<Option<String>, String> {
        match entry(account)?.get_password() {
            Ok(s) => Ok(Some(s)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("无法读取钥匙串：{e}")),
        }
    }

    pub fn set(account: &str, value: &str) -> Result<(), String> {
        entry(account)?.set_password(value).map_err(|e| format!("无法写入钥匙串：{e}"))
    }

    pub fn delete(account: &str) -> Result<(), String> {
        match entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("无法从钥匙串删除：{e}")),
        }
    }
}

/// Builds for other systems exist only for development and tests (the app is macOS-only);
/// they keep credentials in memory for the run.
#[cfg(not(target_os = "macos"))]
mod store {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};

    fn map() -> &'static Mutex<HashMap<String, String>> {
        static MAP: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
        MAP.get_or_init(Default::default)
    }

    pub fn get(account: &str) -> Result<Option<String>, String> {
        Ok(map().lock().unwrap().get(account).cloned())
    }

    pub fn set(account: &str, value: &str) -> Result<(), String> {
        map().lock().unwrap().insert(account.to_string(), value.to_string());
        Ok(())
    }

    pub fn delete(account: &str) -> Result<(), String> {
        map().lock().unwrap().remove(account);
        Ok(())
    }
}

pub fn load(account: &str) -> Result<Option<Credentials>, String> {
    store::get(account)?.map(|s| serde_json::from_str(&s).map_err(|e| format!("钥匙串里的凭据格式有误：{e}"))).transpose()
}

pub fn save(account: &str, c: &Credentials) -> Result<(), String> {
    store::set(account, &serde_json::to_string(c).map_err(|e| e.to_string())?)
}

pub fn delete(account: &str) -> Result<(), String> {
    store::delete(account)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_credentials_read_back_and_delete() {
        // Arrange
        let account = "test:saved_credentials_read_back_and_delete";
        let c = Credentials { access_key_id: "id".into(), access_key_secret: "secret".into() };

        // Act
        save(account, &c).unwrap();
        let back = load(account).unwrap();
        delete(account).unwrap();

        // Assert
        assert_eq!(back, Some(c));
        assert_eq!(load(account).unwrap(), None);
    }
}
