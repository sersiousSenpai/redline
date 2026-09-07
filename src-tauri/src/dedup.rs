// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Near-duplicate suppression and match-centered excerpting — lives in
//! `polis-core` since Session A1 of the Polis extraction
//! (docs/polis-extraction.md). This shim keeps every `crate::dedup::…` path
//! compiling unchanged.

#[allow(unused_imports)]
pub use polis_core::dedup::*;
