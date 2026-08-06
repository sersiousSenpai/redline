// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Golden: `docs/extensions-api.md` is rendered from the ABI crate's tables
//! (`redline_extension_abi::render_extensions_doc`) — the same tables the
//! host and the SDK compile against, so the extension author's contract page
//! cannot drift from the code. Regenerate with
//! `UPDATE_GOLDEN=1 cargo test --test extensions_doc`.

#[test]
fn extensions_doc_golden_is_current() {
    let rendered = redline_extension_abi::render_extensions_doc();
    let path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/extensions-api.md");
    if std::env::var("UPDATE_GOLDEN").is_ok() {
        std::fs::write(&path, &rendered).expect("write extensions doc golden");
        return;
    }
    let committed = std::fs::read_to_string(&path).expect(
        "docs/extensions-api.md missing — run UPDATE_GOLDEN=1 cargo test --test extensions_doc",
    );
    assert_eq!(
        committed, rendered,
        "docs/extensions-api.md is stale — run UPDATE_GOLDEN=1 cargo test --test extensions_doc"
    );
}
