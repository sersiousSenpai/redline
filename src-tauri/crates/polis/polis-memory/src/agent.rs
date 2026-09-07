// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The one seam the memory passes cross to reach a model: `run_memory_agent`
//! sends a seat's prompt through the configured [`polis_llm::Agent`] and books
//! what the turn spent through the configured [`polis_llm::UsageSink`] — on
//! BOTH exits, because a failed pass spent its input tokens too.
//!
//! No agent configured is the R12 state, not a failure: the caller gets a
//! `no model configured` error string and treats the pass as skipped.

use polis_llm::{AgentReply, AgentRequest};

use crate::Polis;

/// What a pass sees when the install has no model. Matched on by the
/// gardener to report `no_model` rather than an error.
pub const NO_MODEL: &str = "no model configured";

/// One memory-seat turn, cost booked on every exit.
pub async fn run_memory_agent(
    polis: &Polis<'_>,
    seat: &str,
    cwd: &str,
    prompt: String,
    response_key: Option<&'static str>,
) -> Result<AgentReply, String> {
    let Some(agent) = polis.agent.as_ref() else {
        return Err(NO_MODEL.to_string());
    };
    let mut req = AgentRequest::new(seat, prompt).cwd(cwd);
    req.response_key = response_key;
    match agent.run(req).await {
        Ok(reply) => {
            polis.sink.book(seat, &reply.usage);
            Ok(reply)
        }
        Err(e) => {
            // Booked before the error return: a failed pass spent its input tokens.
            polis.sink.book(seat, &e.usage);
            Err(e.message)
        }
    }
}

/// Run the classifier headless to completion and return its final text and
/// session id (seat `classifier`; the supersede verifier shares it).
pub async fn run_classifier(
    polis: &Polis<'_>,
    cwd: &str,
    prompt: String,
) -> Result<(String, Option<String>), String> {
    run_memory_agent(polis, "classifier", cwd, prompt, Some("proposals"))
        .await
        .map(|reply| (reply.text, reply.session_id))
}

/// Run the summarizer headless to completion, returning its final text (seat
/// `keeper`; compaction, observations and page captions share it).
pub async fn run_keeper_summarizer(polis: &Polis<'_>, cwd: &str, prompt: String) -> Result<String, String> {
    run_memory_agent(polis, "keeper", cwd, prompt, None)
        .await
        .map(|reply| reply.text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use polis_core::host::NoHost;
    use polis_llm::NoopSink;
    use polis_store::PolisStore;

    #[tokio::test]
    async fn no_agent_is_the_no_model_state_not_a_failure() {
        let store = PolisStore::open_in_memory().unwrap();
        let polis = Polis::new(&store, None, &NoHost, &NoopSink);
        let err = run_classifier(&polis, "/", "p".into()).await.unwrap_err();
        assert_eq!(err, NO_MODEL);
    }
}
