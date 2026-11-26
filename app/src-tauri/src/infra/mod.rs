//! Adapters to the outside world: files, settings, Node, Hexo processes.

pub mod blog;
pub mod git;
pub mod hexo;
pub mod image_encode;
pub mod keychain;
pub mod node_env;
pub mod paths;
pub mod preferences;
pub mod project;
pub mod store;
pub mod user;
pub mod watch;

/// reqwest is built with rustls but no bundled crypto provider (the updater plugin's choice);
/// every client needs one installed first. Installing twice is harmless.
pub fn install_tls() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}
