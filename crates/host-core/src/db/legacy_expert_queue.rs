use super::model_discovery_migration::{
    has_reported_context_window, initialize_reported_context_window,
};
use super::{anyhow, create_migration_backup, now_ms, Connection, Context, Path, Result};

fn has_legacy_queue_column(conn: &Connection) -> Result<bool> {
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('turn_queue')
          WHERE name = 'expert_selection_json')",
        [],
        |row| row.get(0),
    )?)
}

/// The OpenReel fork and upstream assigned schema 34 to different changes.
/// Convert fork databases before maintenance or the upstream queue can see them.
pub(super) fn reconcile(conn: &Connection, path: &Path) -> Result<()> {
    if !has_legacy_queue_column(conn)? {
        if !has_reported_context_window(conn)? {
            return Err(anyhow!(
                "unrecognized database schema v34; expected an upstream model field or a legacy expert queue"
            ));
        }
        return Ok(());
    }

    let backup = create_migration_backup(conn, path, 34)?;
    (|| -> Result<()> {
        let tx = conn.unchecked_transaction()?;
        initialize_reported_context_window(&tx)?;
        // Copy raw SQLite values. Even legacy rows with invalid JSON must
        // never become ordinary queued prompts or disappear from recovery data.
        tx.execute(
            "CREATE TABLE legacy_openreel_expert_turns_v1 AS
             SELECT *, 'queued' AS previous_status, CAST(?1 AS INTEGER) AS archived_at
             FROM turn_queue WHERE expert_selection_json IS NOT NULL",
            [now_ms()],
        )?;
        tx.execute_batch(
            "DELETE FROM turn_queue WHERE expert_selection_json IS NOT NULL;
             DROP TRIGGER IF EXISTS sessions_clear_expert_selection;
             ALTER TABLE turn_queue DROP COLUMN expert_selection_json;",
        )?;
        tx.commit()?;
        Ok(())
    })()
    .with_context(|| {
        format!(
            "reconcile fork and upstream schema v34; backup {} remains",
            backup.display()
        )
    })
}

#[cfg(test)]
#[path = "legacy_expert_queue_tests.rs"]
mod tests;
