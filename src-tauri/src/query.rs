// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Query planning for the lexical layer — lives in `polis-core` since Session
//! A1 of the Polis extraction (docs/polis-extraction.md). This shim keeps every
//! `crate::query::…` path compiling unchanged.

pub use polis_core::query::*;
