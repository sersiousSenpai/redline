// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Language-neutral boundaries for a mission consumer. No desktop dependencies.
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const CONTRACT_SCHEMA: u32 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelContract {
    pub provider: String,
    pub model: String,
    pub local: bool,
    pub capabilities: BTreeSet<String>,
    pub context_limit: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionContract {
    pub environment_id: String,
    pub workspace_id: String,
    pub allowed_tools: BTreeSet<String>,
    pub allowed_hosts: BTreeSet<String>,
    pub credential_refs: Vec<String>,
    pub max_actions: u32,
    pub max_seconds: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunIdentity {
    pub model: ModelContract,
    pub execution: ExecutionContract,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    #[serde(default)]
    pub cached_input_tokens: u64,
    pub elapsed_ms: u64,
}

/// Optional wire events for streaming model adapters. The final structured
/// value is distinct from a successful transport dispatch.
#[allow(dead_code)]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ModelEvent {
    TextDelta {
        sequence: u64,
        text: String,
    },
    ToolCall {
        operation_id: String,
        tool: String,
        arguments: serde_json::Value,
    },
    Completed {
        output: serde_json::Value,
        usage: ModelUsage,
    },
    Cancelled {
        reason: String,
        usage: ModelUsage,
    },
    Failed {
        error: String,
        retryable: bool,
        usage: ModelUsage,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutionAction {
    pub operation_id: String,
    pub sequence: u64,
    pub tool: String,
    pub status: String,
    pub observed_at: i64,
    pub outcome: serde_json::Value,
}

pub fn validate_adapter(
    identity: &RunIdentity,
    workspace: &str,
    local_only: bool,
    allowed_tools: &BTreeSet<String>,
    allowed_hosts: &BTreeSet<String>,
) -> Result<(), String> {
    let model = &identity.model;
    let execution = &identity.execution;
    if model.provider.trim().is_empty()
        || model.model.trim().is_empty()
        || execution.environment_id.trim().is_empty()
    {
        return Err("model and execution identities are required".into());
    }
    if local_only && !model.local {
        return Err("this context permits only local model processing".into());
    }
    if execution.workspace_id != workspace {
        return Err("execution workspace does not own this mission".into());
    }
    if !execution.allowed_tools.is_subset(allowed_tools)
        || !execution.allowed_hosts.is_subset(allowed_hosts)
    {
        return Err("adapter permissions exceed the bot's reviewed permissions".into());
    }
    if !model.capabilities.contains("text")
        || !model.capabilities.contains("structured-output")
        || model.context_limit < 4096
    {
        return Err(
            "model requires text, structured-output, and at least 4096 context tokens".into(),
        );
    }
    if execution.max_actions == 0
        || execution.max_actions > 500
        || execution.max_seconds == 0
        || execution.max_seconds > 3600
    {
        return Err("execution budget must be 1–500 actions and 1–3600 seconds".into());
    }
    if execution
        .credential_refs
        .iter()
        .any(|r| !r.starts_with("credential://"))
    {
        return Err("credentials must be environment-supplied credential:// references".into());
    }
    Ok(())
}

/// A host implements cancellation and checkpoints; adapters return evidence,
/// never write confirmed user judgments or silently expand execution grants.
#[allow(dead_code)]
pub trait MissionConsumer {
    fn identity(&self) -> RunIdentity;
    fn check(
        &mut self,
        context: &serde_json::Value,
        checkpoint: &serde_json::Value,
    ) -> Result<serde_json::Value, String>;
    fn cancel(&mut self);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn changing_adapter_cannot_expand_permissions_or_export_local_context() {
        let mut identity = RunIdentity {
            model: ModelContract {
                provider: "fixture".into(),
                model: "v1".into(),
                local: true,
                capabilities: ["text".into(), "structured-output".into()].into(),
                context_limit: 8192,
            },
            execution: ExecutionContract {
                environment_id: "computer-1".into(),
                workspace_id: "m1".into(),
                allowed_tools: ["read".into()].into(),
                allowed_hosts: ["example.test".into()].into(),
                credential_refs: vec![],
                max_actions: 50,
                max_seconds: 120,
            },
        };
        let tools = identity.execution.allowed_tools.clone();
        let hosts = identity.execution.allowed_hosts.clone();
        assert!(validate_adapter(&identity, "m1", true, &tools, &hosts).is_ok());
        identity.model.local = false;
        assert!(validate_adapter(&identity, "m1", true, &tools, &hosts).is_err());
        identity.model.local = true;
        identity.execution.allowed_tools.insert("send-email".into());
        assert!(validate_adapter(&identity, "m1", true, &tools, &hosts).is_err());
    }
}
