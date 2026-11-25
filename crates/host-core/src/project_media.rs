//! Project libraries outlive individual session records. The plugin broker
//! owns catalog mutations; host-core resolves and cleans their durable owner.

use crate::db::Database;
use crate::session_media::{remove_hashed, validated_directory};
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

// The Electron writer enforces this bound before installing a catalog.
const MAX_CATALOG_BYTES: u64 = 8 * 1024 * 1024;

pub(crate) fn key(id: i64, created_at: i64) -> String {
    // SQLite can reuse projects.id after deletion. Include creation time to
    // keep an orphan separate from a newly registered project. A profile move
    // can rewrite the project path while preserving this row's identity.
    let mut hash = Sha256::new();
    hash.update(id.to_be_bytes());
    hash.update(created_at.to_be_bytes());
    hex::encode(hash.finalize())
}

pub(crate) fn key_for_path(db: &Database, path: &str) -> rusqlite::Result<Option<String>> {
    if path.starts_with("remote-project:") {
        return Ok(None);
    }
    db.conn()
        .query_row(
            "SELECT id, created_at FROM projects WHERE path = ?1",
            [path],
            |row| Ok(key(row.get(0)?, row.get(1)?)),
        )
        .optional()
}

fn base_dir(data_dir: &Path) -> io::Result<PathBuf> {
    Ok(fs::canonicalize(data_dir)?.join("project-media"))
}

fn is_key(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Debug, Default, PartialEq, serde::Serialize)]
pub(crate) struct MediaSummary {
    pub assets: usize,
    pub subjects: usize,
}

pub(crate) fn summary(data_dir: &Path, project: &str) -> io::Result<MediaSummary> {
    let base = base_dir(data_dir)?;
    let library = base.join(project);
    let mut counts = MediaSummary::default();
    if !validated_directory(&base)? || !validated_directory(&library)? {
        return Ok(counts);
    }
    for entry in fs::read_dir(library)? {
        let entry = entry?;
        if !entry.file_name().to_str().is_some_and(is_key) || !validated_directory(&entry.path())? {
            continue;
        }
        let path = entry.path().join("index.json");
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        if !metadata.is_file() || fs::canonicalize(&path)? != path {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "project media catalog is redirected",
            ));
        }
        let mut bytes = Vec::new();
        File::open(path)?
            .take(MAX_CATALOG_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_CATALOG_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "project media catalog is too large",
            ));
        }
        let catalog: serde_json::Value = serde_json::from_slice(&bytes)?;
        if let (Some(assets), Some(subjects), Some(1)) = (
            catalog["assets"].as_array(),
            catalog["subjects"].as_array(),
            catalog["schemaVersion"].as_u64(),
        ) {
            counts.assets += assets.len();
            counts.subjects += subjects.len();
        } else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "invalid project media catalog",
            ));
        }
    }
    Ok(counts)
}

pub(crate) fn remove_project(data_dir: &Path, project: &str) {
    if let Err(error) = base_dir(data_dir).and_then(|base| remove_hashed(&base, project)) {
        tracing::warn!(%error, "project media cleanup failed");
    }
}

pub(crate) fn sweep(db: &Database, data_dir: &Path) {
    let result = (|| -> anyhow::Result<()> {
        let base = base_dir(data_dir)?;
        if !validated_directory(&base)? {
            return Ok(());
        }
        let mut statement = db.conn().prepare("SELECT id, created_at FROM projects")?;
        let live = statement
            .query_map([], |row| Ok(key(row.get(0)?, row.get(1)?)))?
            .collect::<Result<HashSet<_>, _>>()?;
        for entry in fs::read_dir(&base)? {
            let entry = entry?;
            let name = entry.file_name();
            if let Some(project) = name.to_str().filter(|value| is_key(value)) {
                if !live.contains(project) && entry.file_type()?.is_dir() {
                    remove_project(data_dir, project);
                }
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        tracing::warn!(%error, "project media sweep failed");
    }
}
