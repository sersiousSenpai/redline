// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian

//! The restore protocol, separated from its presentation.
//!
//! A reopened plan needs the model to know a fair amount: that Redline already
//! holds the plan and re-presents its own copy, that the submitted body is a
//! marker rather than a revision, which marker, and whether an earlier
//! stand-down in its context has been rescinded. All of that is necessary for
//! the model and none of it is conversation — yet it used to be the visible
//! user prompt, so `claude --resume` replayed the whole paragraph on every
//! later restore and two genuine restores read as one accidental double-send.
//!
//! So the visible trigger is now one compact, timestamped line
//! (`resumeCommand.ts`), and the protocol arrives here instead: the resumed
//! `claude` carries restore metadata in its environment, the command-type
//! capture hook forwards it to `/v1/prompts/ingest` as headers, and the route
//! answers with `hookSpecificOutput.additionalContext` — which Claude Code
//! hands to the model alongside the prompt without rendering it as a message.
//!
//! Two rules this module exists to keep:
//!
//! 1. **The hidden context is an improvement, never a dependency.** The compact
//!    visible trigger carries everything the handshake strictly requires, so a
//!    restore still completes with Redline closed, the hook uninstalled, or the
//!    arming expired.
//! 2. **The marking is one-shot.** The environment rides the whole `claude`
//!    process, and the reviewer may take that terminal over and keep typing in
//!    it once the plan is back. A per-process marker would silently swallow
//!    every one of those prompts, so the daemon arms a token per restore target
//!    and the first matching fire consumes it. Everything typed afterwards is
//!    captured exactly as a human's prompt always was.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The seat value a restore's `claude` runs under. Mirrors `RESTORE_SEAT` in
/// `src/lib/resumeCommand.ts`.
///
/// Deliberately NOT in the blanket agent-text exclusion that every other seat
/// gets (`claude_proc::ENV_AGENT_SEAT`): see rule 2 above. It labels the
/// process; the arming below is what decides whether a given fire is control
/// traffic.
pub const RESTORE_SEAT: &str = "restore";

/// The environment the restore command prefixes onto `claude`, and the headers
/// the capture hook expands it into. Two halves of one contract: the names on
/// the left are written by `RESTORE_ENV` in `resumeCommand.ts`, the names on the
/// right are read by `from_headers` below. `launchInvariants.test.ts` pins the
/// TS half against this file.
pub const ENV_TARGET: &str = "REDLINE_RESTORE_TARGET";
pub const ENV_PRIMED: &str = "REDLINE_RESTORE_PRIMED";
pub const ENV_RESCINDED: &str = "REDLINE_RESTORE_RESCINDED";

/// What Redline's own restore trigger opens with. Mirrors the compact prompt
/// built by `compactRestorePrompt` in `resumeCommand.ts`; pinned across the two
/// by `launchInvariants.test.ts`.
///
/// Load-bearing, not belt-and-braces. The metadata rides the resumed `claude`'s
/// ENVIRONMENT, so it is on every prompt submission that process ever makes —
/// and the CLI fires `UserPromptSubmit` for its own injections too, shaped
/// exactly like a keystroke. A `<system-reminder>` landing first would otherwise
/// consume the arming, inject the restore protocol into a turn that is not the
/// restore, and leave the real trigger with nothing.
pub const TRIGGER_PREFIX: &str = "Redline restore \u{b7} ";

pub const HEADER_TARGET: &str = "X-Redline-Restore";
pub const HEADER_PRIMED: &str = "X-Redline-Restore-Primed";
pub const HEADER_RESCINDED: &str = "X-Redline-Restore-Rescinded";

/// How long an armed restore stays claimable. Generous because "Copy resume
/// command" may be pasted long after the click, and cheap to be wrong about:
/// an expired arming costs the hidden context, not the restore.
const ARM_TTL: Duration = Duration::from_secs(60 * 60);

/// Longest session id we will echo back into a prompt. Real ids are UUIDs (36);
/// the bound is here because the value arrives from a header.
const MAX_TARGET_LEN: usize = 128;

/// The validated restore metadata: which plan is being restored, and the two
/// facts that change what the handshake has to do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreMeta {
    pub target: String,
    pub primed: bool,
    pub rescinded: bool,
}

/// A session id is safe to echo back when it is one of ours: non-empty, bounded,
/// and made only of the characters real ids use. Anything else is dropped rather
/// than sanitized — the value ends up inside a marker the model writes verbatim,
/// so a partially-scrubbed id would produce a marker that binds to nothing.
fn valid_target(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= MAX_TARGET_LEN
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':'))
}

/// A `1`/`true`/`yes` flag header, defaulting to false. The hook always sends
/// the header (`${VAR:-}` keeps it present-but-empty), so absence and empty are
/// the same answer.
fn flag(v: Option<&str>) -> bool {
    matches!(
        v.map(str::trim).unwrap_or("").to_ascii_lowercase().as_str(),
        "1" | "true" | "yes"
    )
}

/// Read restore metadata out of a capture POST's headers. `None` when this is
/// not a restore fire, or when the target it claims is not a shape we will echo.
#[cfg(test)]
pub fn from_headers(headers: &axum::http::HeaderMap) -> Option<RestoreMeta> {
    from_lookup(&polis_server::HttpHeaders(headers))
}

/// The same read over the capture route's header lookup
/// (`polis_core::host::IngestHeaders`, values already trimmed) — what the
/// route's observer (`polis_host::RedlineIngest`) hands us since A6.
pub fn from_lookup(headers: &dyn polis_core::host::IngestHeaders) -> Option<RestoreMeta> {
    let get = |name: &str| headers.get(name);
    let target = get(HEADER_TARGET).filter(|t| !t.is_empty())?;
    if !valid_target(target) {
        tracing::warn!("ignoring a restore header whose target is not a session id shape");
        return None;
    }
    Some(RestoreMeta {
        target: target.to_string(),
        primed: flag(get(HEADER_PRIMED)),
        rescinded: flag(get(HEADER_RESCINDED)),
    })
}

fn armed() -> &'static Mutex<HashMap<String, Instant>> {
    static G: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    G.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Arm a restore: the next capture fire naming `target` is Redline's own
/// control traffic. Called wherever a restore command is dispatched or copied.
/// Re-arming an already-armed target just refreshes its clock.
pub fn arm(target: &str) {
    if !valid_target(target) {
        return;
    }
    let now = Instant::now();
    let mut g = armed().lock().unwrap();
    g.retain(|_, t| now.duration_since(*t) < ARM_TTL);
    g.insert(target.to_string(), now);
}

/// Consume the arming for `target`. True exactly once per `arm`.
pub fn claim(target: &str) -> bool {
    let now = Instant::now();
    let mut g = armed().lock().unwrap();
    g.retain(|_, t| now.duration_since(*t) < ARM_TTL);
    g.remove(target).is_some()
}

/// The full restore protocol, as hidden context.
///
/// This is the text the visible prompt used to be, restored to full length
/// because nothing here costs the reviewer a line of transcript. It says the
/// same thing as `skills/redline-plan-review/SKILL.md` §7 and the compact
/// trigger; those three must agree.
pub fn additional_context(meta: &RestoreMeta) -> String {
    let marker = format!("<!-- REDLINE_RESTORE:{} -->", meta.target);
    let mut s = String::new();
    s.push_str(
        "[Redline restore protocol — injected by Redline, not typed by the user.]\n\n\
         This plan session was reopened in Redline for continued review. Redline \
         already holds your current plan and re-presents its own copy, so the body \
         you submit is a marker, never the plan.\n\n\
         - Do NOT fetch, read or retype the plan, and do not explore the codebase.\n\
         - Do NOT emit a REDLINE_RESOLUTIONS block: a restore is a re-presentation, \
         not a revision.\n\
         - No preamble and no other tool calls.\n\n",
    );
    if meta.primed {
        s.push_str(&format!(
            "Your plan file has already been written for you — it contains exactly \
             `{marker}`. Call ExitPlanMode now, as your very first action. (If your \
             plan file somehow does not contain that line, write it there first.)\n\n"
        ));
    } else {
        s.push_str(&format!(
            "Write exactly `{marker}` as your plan file's contents, then call \
             ExitPlanMode. Write the id verbatim: it is the HELD plan's id, and it \
             is what lets Redline rebind the restore even though this resumed \
             session may have been given a new one.\n\n"
        ));
    }
    s.push_str(
        "If you are not in plan mode, call EnterPlanMode first — `--permission-mode \
         plan` puts a resumed session in plan mode on Claude Code 2.1.222, so that \
         is a fallback rather than a step.\n\n",
    );
    if meta.rescinded {
        s.push_str(
            "An earlier Redline stand-down in your context is void — the reviewer \
             rescinded that approval, and this plan is back in review. Do not act \
             on it.\n\n",
        );
    }
    s.push_str(
        "Redline restores the plan it holds and ignores what you submit. Any actual \
         changes flow through the normal review/revise loop once the plan reopens.",
    );
    s
}

/// The ingest route's whole restore decision, in one place so it can be tested
/// without standing up an `AppState`.
///
/// `Some(body)` means: this capture POST is the restore trigger we armed. Answer
/// it with the protocol as hidden context, and record nothing — it is Redline's
/// own control traffic, not a prompt the user typed. `None` means every other
/// fire, including the reviewer's own next prompt in that same resumed terminal,
/// which takes the ordinary capture path untouched.
///
/// Consumes the arming, so calling it twice for one restore answers once — and
/// only for a body that is actually the trigger, so a CLI injection arriving
/// first cannot spend it.
#[cfg(test)]
pub fn answer(
    headers: &axum::http::HeaderMap,
    prompt: &str,
) -> Option<serde_json::Value> {
    answer_with(&polis_server::HttpHeaders(headers), prompt)
}

/// [`answer`] over the route's header lookup — the observer's entry point.
pub fn answer_with(
    headers: &dyn polis_core::host::IngestHeaders,
    prompt: &str,
) -> Option<serde_json::Value> {
    let meta = from_lookup(headers)?;
    if !prompt.trim_start().starts_with(TRIGGER_PREFIX) {
        return None;
    }
    if !claim(&meta.target) {
        return None;
    }
    tracing::info!(target = %meta.target, primed = meta.primed,
        "answered a restore trigger with the hidden protocol");
    Some(serde_json::json!({
        "skipped": "restore_control",
        "hookSpecificOutput": {
            "hookEventName": "UserPromptSubmit",
            "additionalContext": additional_context(&meta),
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;

    /// A body shaped like the real compact trigger.
    fn trigger() -> String {
        format!("{TRIGGER_PREFIX}2026-09-04 15:10 — call ExitPlanMode now.")
    }

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                axum::http::HeaderValue::from_str(v).unwrap(),
            );
        }
        h
    }

    #[test]
    fn ordinary_prompts_carry_no_restore_metadata() {
        // The hook always sends the headers; empty is how it says "not a restore".
        assert!(from_headers(&headers(&[])).is_none());
        assert!(from_headers(&headers(&[(HEADER_TARGET, "")])).is_none());
        assert!(from_headers(&headers(&[(HEADER_TARGET, "   ")])).is_none());
    }

    #[test]
    fn reads_target_and_both_flags() {
        let m = from_headers(&headers(&[
            (HEADER_TARGET, "36c1d078-aaaa-4bbb-8ccc-000000000001"),
            (HEADER_PRIMED, "1"),
            (HEADER_RESCINDED, "0"),
        ]))
        .expect("a well-formed restore fire");
        assert_eq!(m.target, "36c1d078-aaaa-4bbb-8ccc-000000000001");
        assert!(m.primed);
        assert!(!m.rescinded);
    }

    #[test]
    fn flags_default_off_when_absent_or_empty() {
        let m = from_headers(&headers(&[(HEADER_TARGET, "abc-123")])).unwrap();
        assert!(!m.primed && !m.rescinded);
        let m = from_headers(&headers(&[
            (HEADER_TARGET, "abc-123"),
            (HEADER_PRIMED, ""),
            (HEADER_RESCINDED, "true"),
        ]))
        .unwrap();
        assert!(!m.primed);
        assert!(m.rescinded, "`true` is accepted alongside `1`");
    }

    #[test]
    fn rejects_a_target_that_is_not_a_session_id_shape() {
        // The value is echoed verbatim into a marker the model writes, so a
        // header carrying anything else is dropped rather than scrubbed — a
        // half-scrubbed id yields a marker that binds to nothing.
        for bad in [
            "abc 123",
            "abc/../../etc",
            "abc\"; rm -rf /",
            "<!-- REDLINE_RESTORE -->",
            "id\nid",
            "",
            "  ",
        ] {
            assert!(!valid_target(bad), "{bad:?} must not validate");
        }
        let long = "a".repeat(MAX_TARGET_LEN + 1);
        assert!(!valid_target(&long));
        // …and the route drops such a header rather than trusting it. (Only the
        // ones a HeaderValue can even hold get this far.)
        assert!(from_headers(&headers(&[(HEADER_TARGET, "abc 123")])).is_none());
        assert!(from_headers(&headers(&[(HEADER_TARGET, &long)])).is_none());

        // Real ids do validate: claude UUIDs and codex thread ids alike.
        assert!(valid_target("36c1d078-aaaa-4bbb-8ccc-000000000001"));
        assert!(valid_target("thr_01ABCdef.xyz:2"));
    }

    #[test]
    fn arming_is_consume_once() {
        let id = "arm-once-11111111";
        assert!(!claim(id), "never armed → nothing to claim");
        arm(id);
        assert!(claim(id), "armed → claimed");
        assert!(!claim(id), "consume-once → the second fire is the human typing");
    }

    #[test]
    fn armings_do_not_cross_talk_between_plans() {
        arm("restore-target-aaa");
        arm("restore-target-bbb");
        assert!(claim("restore-target-aaa"));
        assert!(
            claim("restore-target-bbb"),
            "one plan's restore must not consume another's"
        );
    }

    #[test]
    fn a_target_we_would_not_echo_is_never_armable() {
        arm("bad target with spaces");
        assert!(!claim("bad target with spaces"));
    }

    #[test]
    fn primed_context_asks_for_exactly_one_tool_call() {
        let ctx = additional_context(&RestoreMeta {
            target: "abc-123".into(),
            primed: true,
            rescinded: false,
        });
        assert!(ctx.contains("already been written for you"));
        assert!(ctx.contains("<!-- REDLINE_RESTORE:abc-123 -->"));
        assert!(ctx.contains("Call ExitPlanMode now"));
        assert!(
            !ctx.contains("Write exactly"),
            "a primed restore must not pay for a Write round trip"
        );
        assert!(!ctx.contains("stand-down"), "not a rescinded restore");
    }

    #[test]
    fn unprimed_context_carries_the_marker_and_why_the_id_matters() {
        let ctx = additional_context(&RestoreMeta {
            target: "abc-123".into(),
            primed: false,
            rescinded: false,
        });
        assert!(ctx.contains("Write exactly `<!-- REDLINE_RESTORE:abc-123 -->`"));
        assert!(ctx.contains("rebind the restore"));
    }

    #[test]
    fn rescinded_context_voids_the_stale_stand_down() {
        let ctx = additional_context(&RestoreMeta {
            target: "abc-123".into(),
            primed: true,
            rescinded: true,
        });
        assert!(ctx.contains("stand-down in your context is void"));
        assert!(ctx.contains("rescinded that approval"));
    }

    /// The exact response the hook reads off stdout. `hookSpecificOutput` is
    /// what Claude Code looks for; the event name has to be the one being
    /// answered, or the context is dropped on the floor without an error.
    #[test]
    fn an_armed_restore_is_answered_with_useprompt_submit_context() {
        let id = "answer-shape-1";
        arm(id);
        let body = answer(
            &headers(&[(HEADER_TARGET, id), (HEADER_PRIMED, "1")]),
            &trigger(),
        )
        .expect("an armed restore is answered");
        assert_eq!(body["skipped"], "restore_control");
        assert_eq!(
            body["hookSpecificOutput"]["hookEventName"], "UserPromptSubmit",
            "a mis-named event is silently ignored by the CLI"
        );
        let ctx = body["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .expect("additionalContext is a string");
        assert_eq!(
            ctx,
            additional_context(&RestoreMeta {
                target: id.into(),
                primed: true,
                rescinded: false,
            })
        );
        assert!(
            body.get("seq").is_none(),
            "control traffic is not a lake row: no receipt to hand back"
        );
    }

    /// Everything that is not the trigger takes the ordinary path — including
    /// the reviewer's own next prompt in the terminal Redline just opened for
    /// them, which still carries the whole restore environment.
    #[test]
    fn ordinary_prompts_and_later_typing_get_no_context() {
        assert!(
            answer(&headers(&[]), "what does this plan do?").is_none(),
            "a human's own session"
        );
        assert!(
            answer(&headers(&[(HEADER_TARGET, "never-armed-2")]), &trigger()).is_none(),
            "restore metadata alone does not entitle a fire to the protocol"
        );

        let id = "later-typing-3";
        arm(id);
        assert!(
            answer(&headers(&[(HEADER_TARGET, id)]), &trigger()).is_some(),
            "the trigger"
        );
        assert!(
            answer(&headers(&[(HEADER_TARGET, id)]), "now change section 3").is_none(),
            "the next prompt in that same terminal is the human, and is captured"
        );
    }

    /// The CLI fires `UserPromptSubmit` for its own injections, shaped exactly
    /// like a keystroke — and the restore environment is on every one of them.
    /// One landing first must not spend the arming.
    #[test]
    fn a_cli_injection_cannot_consume_the_arming() {
        let id = "injection-first-4";
        arm(id);
        let h = headers(&[(HEADER_TARGET, id)]);
        for noise in [
            "<system-reminder>Your todo list is empty.</system-reminder>",
            "<task-notification>An agent finished.</task-notification>",
            "Caveat: the messages below were generated while running redline.",
        ] {
            assert!(answer(&h, noise).is_none(), "{noise} is not the trigger");
        }
        assert!(
            answer(&h, &trigger()).is_some(),
            "…and the real trigger still finds its arming waiting"
        );
    }

    #[test]
    fn every_context_forbids_fetching_retyping_and_resolutions() {
        for (primed, rescinded) in [(true, true), (true, false), (false, true), (false, false)] {
            let ctx = additional_context(&RestoreMeta {
                target: "abc-123".into(),
                primed,
                rescinded,
            });
            assert!(ctx.contains("do not explore the codebase"));
            assert!(ctx.contains("Do NOT fetch"));
            assert!(ctx.contains("REDLINE_RESOLUTIONS"));
            assert!(ctx.contains("ignores what you submit"));
        }
    }
}
