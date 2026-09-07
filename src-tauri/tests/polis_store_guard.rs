// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Guard: `Database` derefs to `PolisStore` (Session A2 of the Polis
//! extraction), so a method the two share would resolve to `Database`'s
//! silently — Deref precedence hides the collision and the store's version
//! would never be called through the app. The two impls must share NO method
//! name. Associated functions (no `self`) are exempt: they are always
//! path-qualified, so `Database::open` and `PolisStore::open` cannot collide.

mod common;

use std::collections::BTreeSet;

fn method_names(src: &str, impl_header: &str) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut in_impl = false;
    let mut depth = 0i32;
    for line in src.lines() {
        if !in_impl {
            if line.starts_with(impl_header) {
                in_impl = true;
                depth = 0;
            } else {
                continue;
            }
        }
        depth += line.matches('{').count() as i32;
        depth -= line.matches('}').count() as i32;
        let t = line.trim_start();
        let sig = t
            .strip_prefix("pub(crate) fn ")
            .or_else(|| t.strip_prefix("pub fn "))
            .or_else(|| t.strip_prefix("fn "));
        if let Some(sig) = sig {
            // A method takes `self`; the receiver may sit on the same line or
            // the next (rustfmt splits long signatures), so look past the
            // name for `self` before the next `)`.
            let name: String = sig.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            let after = &src[src.find(line).unwrap() + line.len()..];
            let head = line.to_string() + &after.chars().take(200).collect::<String>();
            let params = head.split(')').next().unwrap_or("");
            if params.contains("self") && !name.is_empty() {
                out.insert(name);
            }
        }
        if depth <= 0 && in_impl && line.starts_with('}') {
            in_impl = false;
        }
    }
    out
}

#[test]
fn database_and_store_share_no_method_names() {
    let db = include_str!("../src/db.rs");
    let store = common::polis_source("polis-store", "src/lib.rs");
    let db_methods = method_names(db, "impl Database {");
    let store_methods = method_names(&store, "impl PolisStore {");
    assert!(db_methods.len() > 100, "the scrape found only {} Database methods", db_methods.len());
    assert!(store_methods.len() >= 5, "the scrape found only {} PolisStore methods", store_methods.len());
    let shared: Vec<&String> = db_methods.intersection(&store_methods).collect();
    assert!(
        shared.is_empty(),
        "Database and PolisStore both define {shared:?} — Deref would hide the store's; rename one"
    );
}
