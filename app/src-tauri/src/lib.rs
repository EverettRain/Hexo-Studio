//! Hexo-Studio: write, preview with the real theme, and deploy a Hexo blog.
//!
//! Layers, inner to outer: `domain` (pure rules: config, posts, addresses, log reading),
//! `infra` (files, settings, Node discovery, Hexo processes), `service` (the preview server and
//! the command runner), `shell` (Tauri: window, commands, events).

pub mod domain;
pub mod infra;
pub mod service;
mod shell;

pub use shell::run;
