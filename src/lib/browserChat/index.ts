// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

// The browser chat's structure layer. Read README.md before changing a rule;
// add the rule to invariants.ts and pin it in the same change.
export * from "./scope";
export * from "./turn";
export * from "./chrome";
export { INVARIANTS, invariant, type Invariant } from "./invariants";
export { default as BROWSER_CHAT_CONTRACT } from "./contract.json";
