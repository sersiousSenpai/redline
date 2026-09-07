// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! `polis_meta` — the store's OWN version table.
//!
//! Never `PRAGMA user_version`: that is one 32-bit slot per file, and a host
//! (Redline, whose live database another lineage stamped `2`) already owns it.
//! Three keys version the store as a unit — the schema, the derived lexical
//! layer, and the one-time corpus-role backfill — and `polis.*` settings will
//! live beside them.
//!
//! **Adoption.** A database the host's own migrations built (every Redline
//! install before Session A2) carries the lexical and corpus-role versions
//! under two `app_settings` keys. On the store's FIRST attach — and only then,
//! detected by a missing `schema_version` — those two values are copied here
//! before any versioned block runs, so the first attach appends zero events
//! and rebuilds nothing. `real_db_attach_is_a_noop` in Redline pins that on a
//! copy of the live database.

use rusqlite::{params, Connection, OptionalExtension};

pub const SCHEMA_VERSION_KEY: &str = "schema_version";
pub const LEXICAL_VERSION_KEY: &str = "lexical_version";
pub const CORPUS_ROLE_VERSION_KEY: &str = "corpus_role_version";

/// The store schema's version. Bump when `schema.rs` gains a statement; the
/// idempotent DDL then re-runs once on every existing store.
pub const STORE_SCHEMA_VERSION: &str = "1";

/// The host's legacy `app_settings` keys, read once at adoption.
pub const LEGACY_LEXICAL_KEY: &str = "redline.memory.lexicalVersion";
pub const LEGACY_CORPUS_ROLE_KEY: &str = "redline.memory.corpusRoleVersion";

/// Every `(host key, ours)` pair adoption copies: the two versions, and the
/// four memory settings that moved out of `app_settings` with their code in
/// Session A5 (the organize gate, the observation counter, the mirror's
/// directory and high-water mark).
pub const LEGACY_PAIRS: &[(&str, &str)] = &[
    (LEGACY_LEXICAL_KEY, LEXICAL_VERSION_KEY),
    (LEGACY_CORPUS_ROLE_KEY, CORPUS_ROLE_VERSION_KEY),
    ("redline.classmem.autoApply", "polis.classmem.autoApply"),
    ("redline.keeper.observeCounter", "polis.keeper.observeCounter"),
    ("redline.mirrorDir", "polis.mirror.dir"),
    ("redline.mirror.lastSeq", "polis.mirror.lastSeq"),
];

pub fn ensure_table(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS polis_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
    )
}

pub fn get(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT value FROM polis_meta WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
}

pub fn set(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO polis_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

/// The three versions, `None` where the store has never stamped one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Versions {
    pub schema: Option<String>,
    pub lexical: Option<String>,
    pub corpus_role: Option<String>,
}

pub fn versions(conn: &Connection) -> rusqlite::Result<Versions> {
    Ok(Versions {
        schema: get(conn, SCHEMA_VERSION_KEY)?,
        lexical: get(conn, LEXICAL_VERSION_KEY)?,
        corpus_role: get(conn, CORPUS_ROLE_VERSION_KEY)?,
    })
}

/// Copy the host's legacy version keys into `polis_meta` where the store has
/// none of its own. Tolerates a host with no settings table at all (a fresh
/// standalone store) — that is simply nothing to adopt. Returns how many keys
/// were adopted.
pub fn adopt_legacy(conn: &Connection, settings_table: &str) -> rusqlite::Result<usize> {
    let exists: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![settings_table],
            |r| r.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .unwrap_or(false);
    if !exists {
        return Ok(0);
    }
    let mut adopted = 0;
    for (legacy, ours) in LEGACY_PAIRS {
        if get(conn, ours)?.is_some() {
            continue;
        }
        let legacy_value: Option<String> = conn
            .query_row(
                &format!("SELECT value FROM {settings_table} WHERE key = ?1"),
                params![*legacy],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(v) = legacy_value {
            set(conn, ours, &v)?;
            adopted += 1;
        }
    }
    Ok(adopted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adoption_copies_only_what_the_store_lacks_and_tolerates_no_table() {
        let c = Connection::open_in_memory().unwrap();
        ensure_table(&c).unwrap();
        assert_eq!(adopt_legacy(&c, "app_settings").unwrap(), 0, "no host table → nothing to adopt");

        c.execute_batch(
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO app_settings VALUES ('redline.memory.lexicalVersion', '2');
             INSERT INTO app_settings VALUES ('redline.memory.corpusRoleVersion', '1');",
        )
        .unwrap();
        set(&c, CORPUS_ROLE_VERSION_KEY, "9").unwrap(); // the store already knows this one
        assert_eq!(adopt_legacy(&c, "app_settings").unwrap(), 1);
        let v = versions(&c).unwrap();
        assert_eq!(v.lexical.as_deref(), Some("2"));
        assert_eq!(v.corpus_role.as_deref(), Some("9"), "an existing store value is never overwritten");
        assert_eq!(v.schema, None);
    }

    #[test]
    fn set_upserts() {
        let c = Connection::open_in_memory().unwrap();
        ensure_table(&c).unwrap();
        set(&c, "k", "1").unwrap();
        set(&c, "k", "2").unwrap();
        assert_eq!(get(&c, "k").unwrap().as_deref(), Some("2"));
        assert_eq!(get(&c, "missing").unwrap(), None);
    }
}
