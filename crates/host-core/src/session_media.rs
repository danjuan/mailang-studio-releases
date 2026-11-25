//! Durable plugin media follows the owning session rather than scratch retention.
//! The Electron plugin broker writes the records and images/videos. Host-core
//! owns session existence and removes or sweeps their directory as a unit.

use crate::db::Database;
use rusqlite::OptionalExtension;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::{fs, io};

fn session_hash(id: &str) -> String {
    hex::encode(Sha256::digest(id.as_bytes()))
}

#[derive(Debug, PartialEq)]
pub struct ActiveMediaContext {
    pub project_id: Option<i64>,
    pub project_path: Option<String>,
    pub project_media_key: Option<String>,
}

pub fn active_context(db: &Database, id: &str) -> rusqlite::Result<Option<ActiveMediaContext>> {
    db.conn()
        .query_row(
            "SELECT p.id, p.path, p.created_at FROM sessions s LEFT JOIN projects p ON p.id = s.project_id
             WHERE s.id = ?1 AND s.deleted_at IS NULL",
            [id],
            |row| {
                let project_id: Option<i64> = row.get(0)?;
                let project_path: Option<String> = row.get(1)?;
                let created_at: Option<i64> = row.get(2)?;
                let project_media_key = match (project_id, &project_path, created_at) {
                    (Some(id), Some(path), Some(created_at))
                        if !path.starts_with("remote-project:") =>
                    {
                        Some(crate::project_media::key(id, created_at))
                    }
                    _ => None,
                };
                Ok(ActiveMediaContext {
                    project_id,
                    project_path,
                    project_media_key,
                })
            },
        )
        .optional()
}

pub(crate) fn validated_directory(path: &Path) -> io::Result<bool> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
        {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "session media directory is redirected",
            ));
        }
    }
    if !metadata.is_dir() || metadata.file_type().is_symlink() || fs::canonicalize(path)? != path {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "session media directory is redirected or is not a directory",
        ));
    }
    Ok(true)
}

fn base_dir(data_dir: &Path) -> io::Result<PathBuf> {
    Ok(fs::canonicalize(data_dir)?.join("session-media"))
}

pub(crate) fn remove_hashed(base: &Path, hash: &str) -> io::Result<()> {
    if !validated_directory(base)? {
        return Ok(());
    }
    let directory = base.join(hash);
    if validated_directory(&directory)? {
        match fs::remove_dir_all(directory) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            result => result?,
        }
    }
    Ok(())
}

pub fn remove_session(data_dir: &Path, id: &str) {
    if let Err(error) = base_dir(data_dir).and_then(|base| remove_hashed(&base, &session_hash(id)))
    {
        tracing::warn!(%error, "session media cleanup failed");
    }
}

pub fn sweep(db: &Database, data_dir: &Path) {
    let result = (|| -> anyhow::Result<()> {
        let base = base_dir(data_dir)?;
        if !validated_directory(&base)? {
            return Ok(());
        }
        // A soft-deleted session still owns its files. Sweep only after a
        // successful complete index read and never delete because of age.
        let mut statement = db.conn().prepare("SELECT id FROM sessions")?;
        let ids = statement.query_map([], |row| row.get::<_, String>(0))?;
        let live = ids
            .map(|id| id.map(|id| session_hash(&id)))
            .collect::<Result<HashSet<_>, _>>()?;
        for entry in fs::read_dir(&base)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(hash) = name.to_str().filter(|name| {
                name.len() == 64
                    && name
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            }) else {
                continue;
            };
            if live.contains(hash) || !entry.file_type()?.is_dir() {
                continue;
            }
            if let Err(error) = remove_hashed(&base, hash) {
                tracing::warn!(%error, "orphaned session media cleanup failed");
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        tracing::warn!(%error, "session media sweep failed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sessions;

    #[test]
    fn context_and_sweep_preserve_trashed_sessions_until_permanent_delete() {
        let root = tempfile::tempdir().unwrap();
        let db = Database::open_in_dir(root.path()).unwrap();
        let local = sessions::create_session(&db, None, None, None, None, None).unwrap();
        let project = sessions::create_session(
            &db,
            None,
            None,
            None,
            None,
            Some(root.path().to_string_lossy().into_owned()),
        )
        .unwrap();
        let local_context = active_context(&db, &local.id).unwrap().unwrap();
        assert_eq!(local_context.project_id, None);
        assert_eq!(local_context.project_path, None);
        assert_eq!(local_context.project_media_key, None);
        let project_context = active_context(&db, &project.id).unwrap().unwrap();
        assert_eq!(project_context.project_path, project.project_path);
        assert!(project_context.project_id.is_some());
        assert_eq!(
            project_context.project_media_key,
            crate::project_media::key_for_path(
                &db,
                project_context.project_path.as_deref().unwrap()
            )
            .unwrap()
        );
        db.conn()
            .execute(
                "UPDATE sessions SET deleted_at = 42 WHERE id = ?1",
                [&local.id],
            )
            .unwrap();
        assert_eq!(active_context(&db, &local.id).unwrap(), None);
        assert_eq!(active_context(&db, "missing").unwrap(), None);

        let base = base_dir(root.path()).unwrap();
        let stored = base.join(session_hash(&local.id));
        let orphan = base.join(session_hash("missing"));
        for path in [&stored, &orphan] {
            fs::create_dir_all(path).unwrap();
            fs::write(path.join("asset"), b"local file").unwrap();
        }
        sweep(&db, root.path());
        assert!(stored.exists());
        assert!(!orphan.exists());

        assert!(sessions::delete_session(&db, &local.id).unwrap());
        assert!(!stored.exists());
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_rejects_redirected_base_and_session_directory() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let hash = session_hash("known");
        let outside_session = outside.path().join(&hash);
        fs::create_dir(&outside_session).unwrap();
        let base = base_dir(root.path()).unwrap();

        symlink(outside.path(), &base).unwrap();
        remove_session(root.path(), "known");
        assert!(outside_session.exists());

        fs::remove_file(&base).unwrap();
        fs::create_dir(&base).unwrap();
        symlink(&outside_session, base.join(hash)).unwrap();
        remove_session(root.path(), "known");
        assert!(outside_session.exists());
    }
}
