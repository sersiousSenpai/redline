// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! Durable mission state and portable context. Additive side tables only: old
//! mission rows, ledger events, bundle schemas and hashes remain readable.
use crate::{
    db::Database,
    ledger::{now_millis, sha256_hex},
    mission_contracts::RunIdentity,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const MAX_RECORD_BYTES: usize = 1_048_576;
const MAX_RECORDS: usize = 500;

pub fn initialize(db: &Database) -> Result<(), String> {
    db.lock_conn().execute_batch(
        "CREATE TABLE IF NOT EXISTS mission_records (
            mission_id TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
            body TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
            PRIMARY KEY(mission_id,kind,id));
         CREATE INDEX IF NOT EXISTS mission_records_scope ON mission_records(mission_id,kind,updated_at DESC);
         CREATE UNIQUE INDEX IF NOT EXISTS mission_handoff_idempotency ON mission_records(mission_id,json_extract(body,'$.idempotencyKey')) WHERE kind='handoff';
         CREATE UNIQUE INDEX IF NOT EXISTS mission_run_idempotency ON mission_records(mission_id,json_extract(body,'$.botId'),json_extract(body,'$.idempotencyKey')) WHERE kind='run';
         CREATE TABLE IF NOT EXISTS mission_ingestions (
            mission_id TEXT NOT NULL, fingerprint TEXT NOT NULL, finding_id TEXT NOT NULL,
            run_id TEXT NOT NULL, PRIMARY KEY(mission_id,fingerprint));
         CREATE VIRTUAL TABLE IF NOT EXISTS mission_derivatives USING fts5(mission_id UNINDEXED,capture_id UNINDEXED,text);
         CREATE TRIGGER IF NOT EXISTS mission_immutable_update BEFORE UPDATE ON mission_records
           WHEN OLD.kind IN ('context','artifact','resolution')
           BEGIN SELECT RAISE(ABORT,'published mission records are immutable'); END;
         CREATE TRIGGER IF NOT EXISTS mission_immutable_delete BEFORE DELETE ON mission_records
           WHEN OLD.kind IN ('context','artifact','resolution')
           BEGIN SELECT RAISE(ABORT,'published mission records are immutable'); END;"
    ).map_err(|e| e.to_string())
}

fn encode(value: &Value) -> Result<String, String> {
    let s = serde_json::to_string(value).map_err(|e| e.to_string())?;
    if s.len() > MAX_RECORD_BYTES {
        return Err("mission record exceeds the 1 MiB limit".into());
    }
    Ok(s)
}

pub(crate) fn get(
    c: &Connection,
    mission: &str,
    kind: &str,
    id: &str,
) -> Result<Option<Value>, String> {
    let body: Option<String> = c
        .query_row(
            "SELECT body FROM mission_records WHERE mission_id=?1 AND kind=?2 AND id=?3",
            params![mission, kind, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    body.map(|s| serde_json::from_str(&s).map_err(|e| format!("invalid saved {kind}: {e}")))
        .transpose()
}

fn rows(c: &Connection, mission: &str, kind: &str) -> Result<Vec<Value>, String> {
    let mut stmt = c.prepare("SELECT body FROM mission_records WHERE mission_id=?1 AND kind=?2 ORDER BY updated_at DESC,rowid DESC LIMIT ?3")
        .map_err(|e| e.to_string())?;
    let bodies = stmt
        .query_map(params![mission, kind, MAX_RECORDS + 1], |r| {
            r.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    if bodies.len() > MAX_RECORDS {
        return Err(format!(
            "{kind} has more than {MAX_RECORDS} records; narrow the exported scope"
        ));
    }
    bodies
        .into_iter()
        .map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        .collect()
}

fn summaries(c: &Connection, mission: &str, kind: &str) -> Result<Vec<Value>, String> {
    let mut stmt=c.prepare("SELECT json_remove(body,'$.assets','$.contextAssets','$.contextManifest','$.body','$.evidence','$.confirmedDecisions','$.unresolvedQuestions','$.derivatives','$.keyframes') FROM mission_records WHERE mission_id=?1 AND kind=?2 ORDER BY updated_at DESC,rowid DESC LIMIT 100")
        .map_err(|e|e.to_string())?;
    let bodies = stmt
        .query_map(params![mission, kind], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    bodies
        .into_iter()
        .map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        .collect()
}

fn latest(c: &Connection, mission: &str, kind: &str) -> Result<Option<Value>, String> {
    let body:Option<String>=c.query_row("SELECT body FROM mission_records WHERE mission_id=?1 AND kind=?2 ORDER BY created_at DESC,rowid DESC LIMIT 1",params![mission,kind],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    body.map(|body| serde_json::from_str(&body).map_err(|e| e.to_string()))
        .transpose()
}

fn read_findings(
    c: &Connection,
    mission: &str,
) -> Result<Vec<crate::state::MissionFinding>, String> {
    let mut stmt=c.prepare("SELECT id,mission_id,browse_id,source_url,source_title,body,note,created_at FROM mission_findings WHERE mission_id=?1 ORDER BY created_at,id LIMIT 501").map_err(|e|e.to_string())?;
    let findings = stmt
        .query_map(params![mission], |r| {
            Ok(crate::state::MissionFinding {
                id: r.get(0)?,
                mission_id: r.get(1)?,
                browse_id: r.get(2)?,
                source_url: r.get(3)?,
                source_title: r.get(4)?,
                body: r.get(5)?,
                note: r.get(6)?,
                created_at: r.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    if findings.len() > 500 {
        return Err("a published context supports up to 500 findings; narrow this mission before publishing".into());
    }
    Ok(findings)
}

fn keyed_record(
    c: &Connection,
    m: &str,
    kind: &str,
    key: &str,
    bot: Option<&str>,
) -> Result<Option<Value>, String> {
    let body:Option<String>=c.query_row("SELECT body FROM mission_records WHERE mission_id=?1 AND kind=?2 AND json_extract(body,'$.idempotencyKey')=?3 AND (?4 IS NULL OR json_extract(body,'$.botId')=?4) LIMIT 1",params![m,kind,key,bot],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    body.map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
        .transpose()
}

pub(crate) fn put(
    c: &Connection,
    mission: &str,
    kind: &str,
    id: &str,
    body: &Value,
) -> Result<(), String> {
    c.execute("INSERT INTO mission_records(mission_id,kind,id,body,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)
        ON CONFLICT(mission_id,kind,id) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at",
        params![mission,kind,id,encode(body)?,now_millis()]).map_err(|e| e.to_string())?;
    Ok(())
}

fn append(c: &Connection, mission: &str, kind: &str, id: &str, body: &Value) -> Result<(), String> {
    c.execute("INSERT INTO mission_records(mission_id,kind,id,body,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)",
        params![mission,kind,id,encode(body)?,now_millis()]).map_err(|e| e.to_string())?;
    Ok(())
}

fn required<'a>(v: &'a Value, field: &str) -> Result<&'a str, String> {
    v[field]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| format!("{field} is required"))
}

pub fn validate_scope(db: &Database, mission: &str, workspace: &str) -> Result<(), String> {
    if mission != workspace {
        return Err("mission and workspace do not match".into());
    }
    db.get_mission(mission)
        .map_err(|e| e.to_string())?
        .ok_or("mission not found")?;
    Ok(())
}

fn validate_handoff_scope(db: &Database, mission: &str, workspace: &str) -> Result<(), String> {
    if mission != workspace {
        return Err("mission and workspace do not match".into());
    }
    if mission.starts_with("conversation:") {
        let mut parts = mission.splitn(3, ':');
        parts.next();
        let kind = parts.next().unwrap_or("");
        let id = parts.next().unwrap_or("");
        let (table, column) = conversation_table(kind)?;
        let c = db.lock_conn();
        let exists:bool=c.query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE {column}=?1) OR EXISTS(SELECT 1 FROM mission_records WHERE mission_id=?2 AND kind='handoff')"),params![id,mission],|r|r.get(0)).map_err(|e|e.to_string())?;
        return if exists {
            Ok(())
        } else {
            Err("source conversation not found".into())
        };
    }
    validate_scope(db, mission, workspace)
}

pub fn checkpoint(
    db: &Database,
    mission: &str,
    status: &str,
    next: &str,
    error: Option<&str>,
    synthesize: bool,
) -> Result<(), String> {
    if ![
        "preparing",
        "researching",
        "waiting_for_input",
        "paused",
        "completed",
        "interrupted",
        "failed",
    ]
    .contains(&status)
    {
        return Err("unsupported mission status".into());
    }
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let body = json!({"missionId":mission,"workspaceId":mission,"status":status,"nextAction":next,
        "error":error,"synthesisPending":synthesize,"updatedAt":now_millis()});
    put(&tx, mission, "runtime", "current", &body)?;
    let changed = tx
        .execute(
            "UPDATE missions SET status=?2,updated_at=?3 WHERE mission_id=?1",
            params![mission, status, now_millis()],
        )
        .map_err(|e| e.to_string())?;
    if changed != 1 {
        return Err("mission not found".into());
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn prepare_mission(
    db: &Database,
    mission: &crate::state::Mission,
    tabs_json: &str,
    first_message: &str,
) -> Result<(), String> {
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute("INSERT INTO missions(mission_id,title,goal,status,created_at,updated_at,tabs_json) VALUES(?1,?2,?3,'preparing',?4,?4,?5)",params![mission.mission_id,mission.title,mission.goal,mission.created_at,tabs_json]).map_err(|e|e.to_string())?;
    put(
        &tx,
        &mission.mission_id,
        "runtime",
        "current",
        &json!({"missionId":mission.mission_id,"workspaceId":mission.mission_id,"status":"preparing","nextAction":"Read the goal and sources, identify the first research step, and begin research.","error":null,"synthesisPending":false,"updatedAt":mission.created_at}),
    )?;
    tx.execute("INSERT INTO mission_messages(id,mission_id,role,body,status,created_at) VALUES(?1,?2,'user',?3,'complete',?4)",params![uuid::Uuid::new_v4().to_string(),mission.mission_id,first_message,mission.created_at]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn recover_interrupted(db: &Database) -> Result<(), String> {
    initialize(db)?;
    for mission in db.list_missions().map_err(|e| e.to_string())? {
        if ["preparing", "researching"].contains(&mission.status.as_str()) {
            checkpoint(
                db,
                &mission.mission_id,
                "interrupted",
                "Resume research from the saved goal, evidence and last conversation.",
                Some("Redline closed before this research turn completed."),
                false,
            )?;
        }
    }
    // An external runtime must explicitly reconcile interrupted work; do not
    // replay side effects or infer completion from a disconnected process.
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE mission_records SET body=json_set(body,'$.status','interrupted','$.error','Runtime disconnected; reconcile checkpoints before retrying') WHERE kind='run' AND json_extract(body,'$.status')='running'",[]).map_err(|e| e.to_string())?;
    tx.execute("UPDATE mission_records SET body=json_set(body,'$.status','uncertain','$.error','Redline closed during launch; inspect the destination before retrying') WHERE kind='handoff' AND json_extract(body,'$.status')='launching'",[]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

pub fn resume_context(db: &Database, mission: &str) -> Result<String, String> {
    let c = db.lock_conn();
    let state = json!({"checkpoint":get(&c,mission,"runtime","current")?,
        "mandate":get(&c,mission,"mandate","current")?,
        "currentJudgments":current_judgments(&c,mission)?,
        "questions":rows(&c,mission,"question")?.into_iter().filter(|q| q["status"]=="open" || q["status"]=="deferred").take(12).collect::<Vec<_>>(),
        "latestArtifact":latest(&c,mission,"artifact")?,
    });
    let encoded = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    // Bound on characters, avoiding invalid UTF-8 slices. This is supplementary
    // context; durable records stay complete and can be retrieved by ID.
    Ok(encoded.chars().take(16_000).collect())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextAsset {
    pub status: String,
    pub hash: Option<String>,
    pub content: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublishedContext {
    pub schema: u32,
    pub version_id: String,
    pub mission_id: String,
    pub workspace_id: String,
    pub published_at: i64,
    pub source_ledger_head: String,
    pub artifact_revision: Option<String>,
    pub included_scope: Vec<String>,
    pub local_only: bool,
    pub assets: BTreeMap<String, ContextAsset>,
    pub manifest_hash: String,
}

fn context_hash(context: &PublishedContext) -> Result<String, String> {
    let mut copy = context.clone();
    copy.manifest_hash.clear();
    // The manifest commits to asset hashes, so a least-privilege consumer can
    // verify a selected subset without receiving omitted asset bodies.
    for asset in copy.assets.values_mut() {
        asset.content = None;
    }
    let canonical = serde_json::to_value(&copy).map_err(|e| e.to_string())?;
    Ok(sha256_hex(encode(&canonical)?.as_bytes()))
}

pub fn verify_context(context: &PublishedContext) -> Result<(), String> {
    if context.schema != crate::mission_contracts::CONTRACT_SCHEMA {
        return Err("unsupported mission context schema".into());
    }
    if context.mission_id != context.workspace_id {
        return Err("context workspace mismatch".into());
    }
    if context_hash(context)? != context.manifest_hash {
        return Err("mission manifest hash mismatch".into());
    }
    for (name, asset) in &context.assets {
        match (asset.status.as_str(), &asset.content, &asset.hash) {
            ("available", Some(content), Some(hash))
                if sha256_hex(encode(content)?.as_bytes()) == *hash => {}
            ("omitted" | "expired" | "redacted", None, _) => {}
            _ => return Err(format!("asset {name} failed verification")),
        }
    }
    Ok(())
}

fn asset(content: Value) -> Result<ContextAsset, String> {
    if content.is_null() {
        return Ok(ContextAsset {
            status: "omitted".into(),
            hash: None,
            content: None,
        });
    }
    Ok(ContextAsset {
        status: "available".into(),
        hash: Some(sha256_hex(encode(&content)?.as_bytes())),
        content: Some(content),
    })
}

fn current_judgments(c: &Connection, mission: &str) -> Result<Vec<Value>, String> {
    let resolutions = rows(c, mission, "resolution")?;
    let superseded: BTreeSet<String> = resolutions
        .iter()
        .filter_map(|r| r["supersedes"].as_str().map(str::to_string))
        .collect();
    Ok(resolutions
        .into_iter()
        .filter(|r| {
            !superseded.contains(r["id"].as_str().unwrap_or(""))
                && (r["action"] == "confirm" || r["action"] == "correct")
        })
        .collect())
}

pub fn publish(
    db: &Database,
    mission: &str,
    scope: Vec<String>,
    local_only: bool,
) -> Result<PublishedContext, String> {
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let (title, goal): (String, String) = tx
        .query_row(
            "SELECT title,goal FROM missions WHERE mission_id=?1",
            params![mission],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let findings = read_findings(&tx, mission)?;
    let head: String = tx
        .query_row(
            "SELECT entry_hash FROM ledger_events ORDER BY seq DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| crate::ledger::GENESIS_PREV.into());
    let mut assets = BTreeMap::new();
    let allowed = [
        "mandate",
        "artifact",
        "evidence",
        "judgments",
        "procedure",
        "runHistory",
    ];
    if scope.iter().any(|s| !allowed.contains(&s.as_str())) {
        return Err("unknown context scope".into());
    }
    let latest_artifact = latest(&tx, mission, "artifact")?;
    for part in allowed {
        if !scope.iter().any(|s| s == part) {
            assets.insert(
                part.into(),
                ContextAsset {
                    status: "omitted".into(),
                    hash: None,
                    content: None,
                },
            );
            continue;
        }
        let content = match part {
            "mandate" => {
                json!({"title":title,"goal":goal,"details":get(&tx,mission,"mandate","current")?})
            }
            "artifact" => latest_artifact.clone().unwrap_or(Value::Null),
            "evidence" => {
                let mut entries = Vec::new();
                for f in &findings {
                    let attribution = get(&tx, mission, "finding", &f.id)?;
                    entries.push(json!({"id":f.id,"url":f.source_url,"title":f.source_title,"excerpt":f.body,
                        "observedAt":f.created_at,"origin":if attribution.is_some(){"agent_finding"}else{"user_pin"},"attribution":attribution}));
                }
                json!({"findings":entries,"sources":rows(&tx,mission,"source")?,"captures":rows(&tx,mission,"capture")?.into_iter().map(capture_export_metadata).collect::<Vec<_>>()})
            }
            "judgments" => {
                json!({"current":current_judgments(&tx,mission)?,"history":rows(&tx,mission,"resolution")?})
            }
            "procedure" => get(&tx, mission, "procedure", "current")?
                .unwrap_or(json!({"steps":[],"preferences":[],"inferredPreferences":[]})),
            _ => {
                json!({"runs":summaries(&tx,mission,"run")?,"unresolvedQuestions":rows(&tx,mission,"question")?})
            }
        };
        assets.insert(part.into(), asset(content)?);
    }
    let mut context = PublishedContext {
        schema: 1,
        version_id: uuid::Uuid::new_v4().to_string(),
        mission_id: mission.into(),
        workspace_id: mission.into(),
        published_at: now_millis(),
        source_ledger_head: head,
        artifact_revision: latest_artifact
            .as_ref()
            .and_then(|a| a["id"].as_str())
            .map(str::to_string),
        included_scope: scope,
        local_only,
        assets,
        manifest_hash: String::new(),
    };
    context.manifest_hash = context_hash(&context)?;
    append(
        &tx,
        mission,
        "context",
        &context.version_id,
        &serde_json::to_value(&context).map_err(|e| e.to_string())?,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(context)
}

pub fn resolve(db: &Database, mission: &str, version: &str) -> Result<PublishedContext, String> {
    let c = db.lock_conn();
    let v = if version=="latest" {
        let id:Option<String>=c.query_row("SELECT id FROM mission_records WHERE mission_id=?1 AND kind='context' ORDER BY created_at DESC,rowid DESC LIMIT 1",params![mission],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
        id.map(|id|get(&c,mission,"context",&id)).transpose()?.flatten()
    } else { get(&c,mission,"context",version)? }.ok_or("publish a mission context version first")?;
    let context: PublishedContext = serde_json::from_value(v).map_err(|e| e.to_string())?;
    verify_context(&context)?;
    Ok(context)
}

/// Wrap, never rewrite, the existing Polis bundle. Its original verifier and
/// hash-chain semantics continue to apply to old and new exports.
pub fn export(db: &Database, mission: &str, version: &str) -> Result<Value, String> {
    let context = resolve(db, mission, version)?;
    let ledger =
        crate::bundle::build_bundle(db, &crate::bundle::BundleScope::Mission(mission.into()))?;
    if !crate::bundle::verify_bundle(&ledger).ok {
        return Err("existing Polis bundle failed verification".into());
    }
    Ok(json!({"schema":"redline.mission-bundle.v1","context":context,"ledgerBundle":ledger}))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundationRequest {
    pub mission_id: String,
    pub workspace_id: String,
    #[serde(flatten)]
    pub action: FoundationAction,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum FoundationAction {
    Read,
    SaveMandate {
        mandate: Value,
        procedure: Value,
    },
    Publish {
        scope: Vec<String>,
        local_only: bool,
    },
    Resolve {
        version_id: String,
    },
    Export {
        version_id: String,
    },
    CreateBot {
        definition: Value,
    },
    StartRun {
        bot_id: String,
        idempotency_key: String,
        identity: RunIdentity,
    },
    CheckpointRun {
        run_id: String,
        checkpoint: Value,
    },
    FinishRun {
        run_id: String,
        status: String,
        coverage: Value,
    },
    IngestFinding {
        run_id: String,
        finding: Value,
    },
    Observe {
        observation: Value,
    },
    ResolveQuestion {
        question_id: String,
        action: String,
        explanation: String,
        supersedes: Option<String>,
    },
    ConfigureCapture {
        policy: Value,
    },
    EnqueueCapture {
        capture: Value,
    },
    IndexCapture {
        capture_id: String,
        derivatives: Value,
    },
    PruneCaptures,
    SearchEvidence {
        query: String,
    },
    GetCapture {
        capture_id: String,
    },
    PrepareHandoff {
        destination: String,
        body: String,
        message_ids: Vec<String>,
        idempotency_key: String,
    },
    GetHandoff {
        handoff_id: String,
    },
    ClaimHandoff {
        handoff_id: String,
    },
    ReleaseHandoff {
        handoff_id: String,
        claim_token: String,
        retryable: bool,
        error: String,
    },
    DeliverHandoff {
        handoff_id: String,
        destination_id: String,
        claim_token: Option<String>,
    },
    CuratedExamples,
}

/// Keep the large tagged request parser shared by HTTP and desktop transports.
/// Parsing their JSON Values here avoids specializing this enum and its nested
/// runtime contracts for each transport's distinct deserializer.
#[inline(never)]
pub fn parse_request(request: Value) -> Result<FoundationRequest, String> {
    serde_json::from_value(request).map_err(|e| format!("Invalid mission request: {e}"))
}

pub fn dispatch(db: &Database, request: FoundationRequest) -> Result<Value, String> {
    validate_handoff_scope(db, &request.mission_id, &request.workspace_id)?;
    let m = &request.mission_id;
    if m.starts_with("conversation:")
        && !matches!(
            &request.action,
            FoundationAction::Read
                | FoundationAction::GetHandoff { .. }
                | FoundationAction::ClaimHandoff { .. }
                | FoundationAction::ReleaseHandoff { .. }
                | FoundationAction::DeliverHandoff { .. }
        )
    {
        return Err(
            "conversation scope supports prepared handoff retrieval and delivery only".into(),
        );
    }
    match request.action {
        FoundationAction::Read => read_state(db, m),
        FoundationAction::Publish { scope, local_only } => {
            serde_json::to_value(publish(db, m, scope, local_only)?).map_err(|e| e.to_string())
        }
        FoundationAction::Resolve { version_id } => {
            serde_json::to_value(resolve(db, m, &version_id)?).map_err(|e| e.to_string())
        }
        FoundationAction::Export { version_id } => export(db, m, &version_id),
        FoundationAction::SaveMandate { mandate, procedure } => {
            let mut c = db.lock_conn();
            let tx = c.transaction().map_err(|e| e.to_string())?;
            put(&tx, m, "mandate", "current", &mandate)?;
            put(&tx, m, "procedure", "current", &procedure)?;
            tx.commit().map_err(|e| e.to_string())?;
            Ok(json!({"saved":true}))
        }
        FoundationAction::CreateBot { definition } => create_bot(db, m, definition),
        FoundationAction::StartRun {
            bot_id,
            idempotency_key,
            identity,
        } => start_run(db, m, &bot_id, &idempotency_key, identity),
        FoundationAction::CheckpointRun { run_id, checkpoint } => {
            update_run(db, m, &run_id, None, checkpoint)
        }
        FoundationAction::FinishRun {
            run_id,
            status,
            coverage,
        } => update_run(db, m, &run_id, Some(&status), coverage),
        FoundationAction::IngestFinding { run_id, finding } => {
            ingest_finding(db, m, &run_id, finding)
        }
        FoundationAction::Observe { observation } => observe(db, m, observation),
        FoundationAction::ResolveQuestion {
            question_id,
            action,
            explanation,
            supersedes,
        } => resolve_question(db, m, &question_id, &action, &explanation, supersedes),
        FoundationAction::ConfigureCapture { policy } => configure_capture(db, m, policy),
        FoundationAction::EnqueueCapture { capture } => enqueue_capture(db, m, capture),
        FoundationAction::IndexCapture {
            capture_id,
            derivatives,
        } => index_capture(db, m, &capture_id, derivatives),
        FoundationAction::PruneCaptures => prune_captures(db, m),
        FoundationAction::SearchEvidence { query } => search_evidence(db, m, &query),
        FoundationAction::GetCapture { capture_id } => {
            prune_captures(db, m)?;
            crate::mission_capture::readable_capture(db, m, &capture_id)
        }
        FoundationAction::PrepareHandoff {
            destination,
            body,
            message_ids,
            idempotency_key,
        } => prepare_handoff(db, m, &destination, &body, &message_ids, &idempotency_key),
        FoundationAction::GetHandoff { handoff_id } => {
            get(&db.lock_conn(), m, "handoff", &handoff_id)?
                .ok_or_else(|| "handoff not found".into())
        }
        FoundationAction::ClaimHandoff { handoff_id } => claim_handoff(db, m, &handoff_id),
        FoundationAction::ReleaseHandoff {
            handoff_id,
            claim_token,
            retryable,
            error,
        } => release_handoff(db, m, &handoff_id, &claim_token, retryable, &error),
        FoundationAction::DeliverHandoff {
            handoff_id,
            destination_id,
            claim_token,
        } => deliver_handoff(db, m, &handoff_id, &destination_id, claim_token.as_deref()),
        FoundationAction::CuratedExamples => {
            let c = db.lock_conn();
            Ok(
                json!({"schema":1,"missionId":m,"examples":current_judgments(&c,m)?,"purpose":"curated examples for future evaluation; no training performed"}),
            )
        }
    }
}

#[tauri::command]
pub async fn mission_foundation(
    app: tauri::AppHandle,
    mission: tauri::State<'_, crate::mission::MissionState>,
    request: Value,
) -> Result<Value, String> {
    let db = mission.db.clone();
    let resume_capture = request["op"] == "configureCapture";
    let worker_db = db.clone();
    let result = tokio::task::spawn_blocking(move || dispatch(&worker_db, parse_request(request)?))
        .await
        .map_err(|e| e.to_string())??;
    if resume_capture {
        crate::mission_capture::resume(app, db);
    }
    Ok(result)
}

fn read_state(db: &Database, m: &str) -> Result<Value, String> {
    let c = db.lock_conn();
    Ok(
        json!({"runtime":get(&c,m,"runtime","current")?,"mandate":get(&c,m,"mandate","current")?,
        "bots":rows(&c,m,"bot")?,"runs":summaries(&c,m,"run")?,"questions":rows(&c,m,"question")?,
        "judgments":current_judgments(&c,m)?,"handoffs":summaries(&c,m,"handoff")?,
        "capturePolicy":get(&c,m,"capture_policy","current")?,"captures":summaries(&c,m,"capture")?,
        "versions":summaries(&c,m,"context")?,"historyWindow":100}),
    )
}

fn string_set(v: &Value, field: &str) -> Result<BTreeSet<String>, String> {
    serde_json::from_value(v[field].clone())
        .map_err(|_| format!("{field} must be a list of strings"))
}

fn create_bot(db: &Database, m: &str, mut definition: Value) -> Result<Value, String> {
    required(&definition, "name")?;
    required(&definition, "mandate")?;
    let cadence = required(&definition, "cadence")?;
    if !["daily", "weekly", "manual"].contains(&cadence) {
        return Err("cadence must be daily, weekly, or manual".into());
    }
    required(&definition, "timeZone")?;
    let mode = required(&definition, "contextMode")?;
    if !["pinned", "follow"].contains(&mode) {
        return Err("context mode must be pinned or follow".into());
    }
    let version = required(&definition, "versionId")?;
    let context = resolve(db, m, version)?;
    let scope = string_set(&definition, "contextScope")?;
    if !scope.is_subset(&context.included_scope.iter().cloned().collect()) {
        return Err("bot scope exceeds this published version".into());
    }
    let allowed = string_set(&definition, "allowedTools")?;
    if !allowed.is_subset(&["read".into(), "fetch".into(), "snapshot".into()].into()) {
        return Err("monitoring bots support reviewed read, fetch and snapshot actions".into());
    }
    let hosts = string_set(&definition, "allowedHosts")?;
    if hosts.is_empty()
        || hosts.len() > 100
        || hosts
            .iter()
            .any(|h| h.contains('/') || h.contains('*') || h.is_empty())
    {
        return Err("provide 1–100 exact source hostnames".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    definition["id"] = json!(id);
    definition["missionId"] = json!(m);
    definition["workspaceId"] = json!(m);
    definition["versionId"] = json!(context.version_id);
    definition["createdAt"] = json!(now_millis());
    definition["overlapPolicy"] = json!("reject");
    definition["retryLimit"] = json!(2);
    definition["localOnly"] = json!(context.local_only || definition["localOnly"] == true);
    definition["status"] = json!("ready");
    append(&db.lock_conn(), m, "bot", &id, &definition)?;
    Ok(definition)
}

fn start_run(
    db: &Database,
    m: &str,
    bot_id: &str,
    key: &str,
    identity: RunIdentity,
) -> Result<Value, String> {
    if key.trim().is_empty() || key.len() > 200 {
        return Err("run idempotency key must contain 1–200 bytes".into());
    }
    let (bot, existing) = {
        let c = db.lock_conn();
        (
            get(&c, m, "bot", bot_id)?.ok_or("bot not found")?,
            keyed_record(&c, m, "run", key, Some(bot_id))?,
        )
    };
    if let Some(run) = existing {
        if run["identity"] != serde_json::to_value(&identity).map_err(|e| e.to_string())? {
            return Err("this run key belongs to a different model or execution identity".into());
        }
        return Ok(run);
    }
    let version = if bot["contextMode"] == "follow" {
        "latest"
    } else {
        required(&bot, "versionId")?
    };
    let context = resolve(db, m, version)?;
    let tools = string_set(&bot, "allowedTools")?;
    let hosts = string_set(&bot, "allowedHosts")?;
    crate::mission_contracts::validate_adapter(
        &identity,
        m,
        context.local_only || bot["localOnly"] == true,
        &tools,
        &hosts,
    )?;
    let requested = string_set(&bot, "contextScope")?;
    if let Some(required) = bot.get("requiredCapabilities") {
        let required: BTreeSet<String> = serde_json::from_value(required.clone())
            .map_err(|_| "requiredCapabilities must be a list of capabilities")?;
        if !required.is_subset(&identity.model.capabilities) {
            return Err("model does not support the bot's required capabilities".into());
        }
    }
    if !requested.is_subset(&context.included_scope.iter().cloned().collect()) {
        return Err("latest version omits required bot context; publish a suitable version or pin a previous one".into());
    }
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    if let Some(run) = keyed_record(&tx, m, "run", key, Some(bot_id))? {
        if run["identity"] != serde_json::to_value(&identity).map_err(|e| e.to_string())? {
            return Err("this run key belongs to a different model or execution identity".into());
        }
        return Ok(run);
    }
    let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM mission_records WHERE mission_id=?1 AND kind='run' AND json_extract(body,'$.botId')=?2 AND json_extract(body,'$.status') IN ('running','interrupted'))",params![m,bot_id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if active {
        return Err("this bot has running or interrupted work; reconcile or cancel that run before starting another".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let context_assets: BTreeMap<_, _> = context
        .assets
        .iter()
        .filter(|(name, _)| requested.contains(*name))
        .map(|(name, asset)| (name.clone(), asset.clone()))
        .collect();
    if serde_json::to_vec(&context_assets)
        .map_err(|e| e.to_string())?
        .len()
        > identity.model.context_limit.saturating_mul(4)
    {
        return Err("selected context exceeds the model adapter's byte budget; select a narrower context scope".into());
    }
    let mut manifest = context.clone();
    for asset in manifest.assets.values_mut() {
        asset.content = None;
    }
    let run = json!({"id":id,"missionId":m,"workspaceId":m,"botId":bot_id,"idempotencyKey":key,
        "versionId":context.version_id,"manifestHash":context.manifest_hash,"contextScope":requested,
        "contextManifest":manifest,"contextAssets":context_assets,
        "identity":identity,"status":"running","startedAt":now_millis(),"checkpoint":{},"coverage":{},"actions":[]});
    append(&tx, m, "run", &id, &run)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(run)
}

fn update_run(
    db: &Database,
    m: &str,
    run_id: &str,
    status: Option<&str>,
    value: Value,
) -> Result<Value, String> {
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let mut run = get(&tx, m, "run", run_id)?.ok_or("run not found")?;
    if run["status"] != "running" && run["status"] != "interrupted" {
        return Err("completed run records cannot change".into());
    }
    if let Some(actions) = value.get("actions") {
        let parsed: Vec<crate::mission_contracts::ExecutionAction> =
            serde_json::from_value(actions.clone())
                .map_err(|e| format!("invalid action history: {e}"))?;
        let prior = run["actions"]
            .as_array()
            .ok_or("saved action history is invalid")?;
        let next = actions.as_array().ok_or("actions must be an array")?;
        if next.len() < prior.len() || !next.starts_with(prior) {
            return Err("action history is append-only".into());
        }
        let allowed: BTreeSet<String> =
            serde_json::from_value(run["identity"]["execution"]["allowedTools"].clone())
                .map_err(|e| e.to_string())?;
        let max = run["identity"]["execution"]["maxActions"]
            .as_u64()
            .unwrap_or(0) as usize;
        let operations: BTreeSet<&str> = parsed.iter().map(|a| a.operation_id.as_str()).collect();
        if operations.len() > max
            || parsed.len() > max.saturating_mul(5)
            || parsed.iter().any(|a| {
                !allowed.contains(&a.tool)
                    || !["accepted", "running", "completed", "interrupted", "failed"]
                        .contains(&a.status.as_str())
            })
        {
            return Err(
                "action history exceeds the reviewed tools, states, or resource budget".into(),
            );
        }
        if parsed.windows(2).any(|w| w[1].sequence <= w[0].sequence) {
            return Err("action history sequence must increase".into());
        }
        run["actions"] = actions.clone();
    }
    if let Some(usage) = value.get("usage") {
        let usage: crate::mission_contracts::ModelUsage = serde_json::from_value(usage.clone())
            .map_err(|e| format!("invalid model usage: {e}"))?;
        run["usage"] = serde_json::to_value(usage).map_err(|e| e.to_string())?;
    }
    if let Some(status) = status {
        if !["completed", "partial", "failed", "cancelled"].contains(&status) {
            return Err("invalid terminal run status".into());
        }
        let failed = value["failedSources"].as_array().map_or(0, Vec::len);
        if status == "completed" && failed > 0 {
            return Err("failed sources require a partial-coverage report".into());
        }
        run["status"] = json!(status);
        run["coverage"] = value;
        run["finishedAt"] = json!(now_millis());
    } else {
        run["checkpoint"] = value;
        run["checkpointAt"] = json!(now_millis());
    }
    put(&tx, m, "run", run_id, &run)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(run)
}

fn ingest_finding(
    db: &Database,
    m: &str,
    run_id: &str,
    mut finding: Value,
) -> Result<Value, String> {
    let body = required(&finding, "body")?.to_string();
    let fingerprint = required(&finding, "fingerprint")?.to_string();
    if fingerprint.len() > 256 {
        return Err("finding fingerprint exceeds 256 bytes".into());
    }
    let sources = finding["sources"]
        .as_array()
        .filter(|s| !s.is_empty() && s.len() <= 30)
        .ok_or("finding needs 1–30 dated sources")?
        .clone();
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let run = get(&tx, m, "run", run_id)?.ok_or("run not found")?;
    let duplicate: Option<String> = tx
        .query_row(
            "SELECT finding_id FROM mission_ingestions WHERE mission_id=?1 AND fingerprint=?2",
            params![m, fingerprint],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if run["status"] != "running" {
        if let Some(id) = duplicate {
            return Ok(json!({"findingId":id,"duplicate":true}));
        }
        return Err("only a running run can append new findings".into());
    }
    let hosts: BTreeSet<String> =
        serde_json::from_value(run["identity"]["execution"]["allowedHosts"].clone())
            .map_err(|e| e.to_string())?;
    let mut source_ids = Vec::new();
    let id = duplicate
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    for source in &sources {
        let url = required(source, "url")?;
        let parsed = tauri::Url::parse(url).map_err(|_| "source URL is invalid")?;
        if !["https", "http"].contains(&parsed.scheme())
            || !hosts.contains(parsed.host_str().unwrap_or(""))
        {
            return Err("finding source is outside the run's allowed hosts".into());
        }
        let excerpt = required(source, "excerpt")?;
        if source["observedAt"].as_i64().filter(|n| *n > 0).is_none() {
            return Err("source observation timestamp is required".into());
        }
        let hash = sha256_hex(excerpt.as_bytes());
        if source["contentHash"].as_str().is_some_and(|h| h != hash) {
            return Err("source excerpt hash mismatch".into());
        }
        let sid =
            sha256_hex(format!("{url}\n{hash}\n{}\n{run_id}", source["observedAt"]).as_bytes());
        let mut saved = source.clone();
        saved["id"] = json!(sid);
        saved["contentHash"] = json!(hash);
        saved["runId"] = json!(run_id);
        saved["findingId"] = json!(id);
        if get(&tx, m, "source", &sid)?.is_none() {
            append(&tx, m, "source", &sid, &saved)?;
            ledger_record(&tx, m, "observation", "mission_source", &sid, &saved)?;
        }
        source_ids.push(sid);
    }
    if duplicate.is_some() {
        let mut existing = get(&tx, m, "finding", &id)?.ok_or("finding attribution is missing")?;
        let mut citations: BTreeSet<String> = existing["sourceIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|s| s.as_str().map(str::to_string))
            .collect();
        citations.extend(source_ids);
        existing["sourceIds"] = json!(citations);
        put(&tx, m, "finding", &id, &existing)?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(json!({"findingId":id,"duplicate":true}));
    }
    let first = &sources[0];
    tx.execute("INSERT INTO mission_findings(id,mission_id,browse_id,source_url,source_title,body,note,created_at) VALUES(?1,?2,NULL,?3,?4,?5,?6,?7)",
        params![id,m,first["url"].as_str(),first["title"].as_str(),body,finding["relevance"].as_str(),now_millis()]).map_err(|e|e.to_string())?;
    finding["id"] = json!(id);
    finding["origin"] = json!("agent_finding");
    finding["status"] = json!("proposed");
    finding["runId"] = json!(run_id);
    finding["botId"] = run["botId"].clone();
    finding["versionId"] = run["versionId"].clone();
    finding["sourceIds"] = json!(source_ids);
    append(&tx, m, "finding", &id, &finding)?;
    tx.execute("INSERT INTO mission_ingestions(mission_id,fingerprint,finding_id,run_id) VALUES(?1,?2,?3,?4)",params![m,fingerprint,id,run_id]).map_err(|e|e.to_string())?;
    ledger_record(&tx, m, "observation", "mission_finding", &id, &finding)?;
    // A bot hypothesis stays a proposal until the user's explicit resolution.
    let qid = format!("finding-{id}");
    append(
        &tx,
        m,
        "question",
        &qid,
        &json!({"id":qid,"observationId":id,"findingId":id,"missionId":m,
        "question":"Should this finding guide future monitoring?","body":body,"sourceRefs":source_ids,"scope":finding["scope"],
        "priority":finding["priority"].as_u64().unwrap_or(50).min(100),"observedAt":now_millis(),"status":"open"}),
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({"findingId":id,"duplicate":false}))
}

fn ledger_record(
    c: &Connection,
    m: &str,
    kind: &str,
    ref_kind: &str,
    id: &str,
    body: &Value,
) -> Result<crate::ledger::LedgerEventRow, String> {
    let hash = sha256_hex(encode(body)?.as_bytes());
    let author = crate::ledger::local_author();
    polis_store::PolisStore::append_ledger_event_locked(
        c,
        &crate::ledger::LedgerAppend {
            kind,
            author: &author,
            ts: now_millis(),
            prompt_id: None,
            session_id: Some(m),
            version_number: None,
            ref_kind: Some(ref_kind),
            ref_id: Some(id),
            payload_hash: &hash,
        },
    )
    .map_err(|e| e.to_string())
}

fn observe(db: &Database, m: &str, mut observation: Value) -> Result<Value, String> {
    let id = required(&observation, "id")?.to_string();
    required(&observation, "action")?;
    required(&observation, "url")?;
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    if let Some(existing) = get(&tx, m, "observation", &id)? {
        return Ok(existing);
    }
    let pending = rows(&tx, m, "question")?
        .into_iter()
        .filter(|q| q["status"] == "open" || q["status"] == "deferred")
        .count();
    if pending >= 100 {
        return Err(
            "gardener review queue is full (100); resolve or dismiss questions before adding more"
                .into(),
        );
    }
    observation["missionId"] = json!(m);
    observation["observedAt"] = json!(observation["observedAt"]
        .as_i64()
        .unwrap_or_else(now_millis));
    append(&tx, m, "observation", &id, &observation)?;
    let qid = format!("observation-{id}");
    let question = json!({"id":qid,"observationId":id,"missionId":m,"status":"open","priority":observation["priority"].as_u64().unwrap_or(50).min(100),
        "question":"What should future research learn from this action?","body":observation["action"],"url":observation["url"],
        "observedAt":observation["observedAt"],"sourceRefs":observation["sourceRefs"],"visualRefs":observation["visualRefs"],"scope":observation["scope"],
        "uncertainty":"Navigation alone does not establish relevance, rejection, duplication, or intent."});
    append(&tx, m, "question", &qid, &question)?;
    ledger_record(
        &tx,
        m,
        "observation",
        "mission_observation",
        &id,
        &observation,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(question)
}

fn resolve_question(
    db: &Database,
    m: &str,
    qid: &str,
    action: &str,
    explanation: &str,
    supersedes: Option<String>,
) -> Result<Value, String> {
    if !["confirm", "correct", "defer", "dismiss"].contains(&action) {
        return Err("resolution must confirm, correct, defer, or dismiss".into());
    }
    if ["confirm", "correct"].contains(&action) && explanation.trim().is_empty() {
        return Err("record the judgment or correction in your own words".into());
    }
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let mut question = get(&tx, m, "question", qid)?.ok_or("question not found")?;
    let previous = question["resolutionId"].as_str().map(str::to_string);
    if supersedes.is_some() && supersedes != previous {
        return Err("resolution changed; reload the question before superseding it".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let resolution = json!({"id":id,"missionId":m,"questionId":qid,"observationId":question["observationId"],
        "action":action,"explanation":explanation.trim(),"actor":crate::ledger::local_author(),"observedAt":question["observedAt"],
        "resolvedAt":now_millis(),"scope":question["scope"],"sourceRefs":question["sourceRefs"],"supersedes":previous});
    let event = ledger_record(&tx, m, "resolution", "mission_resolution", &id, &resolution)?;
    let mut saved = resolution;
    saved["ledger"] = json!({"seq":event.seq,"prevHash":event.prev_hash,"entryHash":event.entry_hash,"payloadHash":event.payload_hash});
    append(&tx, m, "resolution", &id, &saved)?;
    question["status"] = json!(match action {
        "defer" => "deferred",
        "dismiss" => "dismissed",
        _ => "resolved",
    });
    question["resolutionId"] = json!(id);
    put(&tx, m, "question", qid, &question)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(saved)
}

fn configure_capture(db: &Database, m: &str, policy: Value) -> Result<Value, String> {
    if !policy.is_object() {
        return Err("capture policy must be an object".into());
    }
    let tabs = string_set(&policy, "tabIds")?;
    let excluded = string_set(&policy, "excludedHosts")?;
    if policy["enabled"] == true && tabs.is_empty() {
        return Err("select at least one mission tab before enabling capture".into());
    }
    if tabs.len() > 20 || excluded.len() > 100 {
        return Err("capture scope exceeds the configured limit".into());
    }
    for (key, max) in [
        ("maxDurationMs", 30_000),
        ("maxBytes", 256 * 1024 * 1024),
        ("retentionMs", 30 * 24 * 60 * 60 * 1000i64),
    ] {
        if policy[key]
            .as_i64()
            .filter(|n| *n > 0 && *n <= max)
            .is_none()
        {
            return Err(format!("{key} must be between 1 and {max}"));
        }
    }
    if policy["localOnly"] != true {
        return Err("the installed capture adapter supports local processing only".into());
    }
    put(&db.lock_conn(), m, "capture_policy", "current", &policy)?;
    Ok(policy)
}

/// Call BEFORE asking the native screenshot service to capture. The global
/// exclusion list remains authoritative; mission scope can only narrow it.
pub(crate) fn capture_scope_policy(
    db: &Database,
    m: &str,
    tab: &str,
    url: &str,
) -> Result<Value, String> {
    capture_policy_in(&db.lock_conn(), m, tab, url, true)
}

pub(crate) fn capture_policy_in(
    c: &Connection,
    m: &str,
    tab: &str,
    url: &str,
    require_active: bool,
) -> Result<Value, String> {
    let setting = |key: &str| -> Result<Option<String>, String> {
        c.query_row("SELECT value FROM app_settings WHERE key=?1", [key], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())
    };
    let global = setting(crate::shots::SETTING_SHOT_DENYLIST)?.unwrap_or_default();
    if (require_active && setting(crate::shots::SETTING_SHOTS_ENABLED)?.as_deref() == Some("false"))
        || !crate::shots::capture_allowed(&global, url)
    {
        return Err("capture excluded by the global policy".into());
    }
    let policy = get(c, m, "capture_policy", "current")?.ok_or("mission capture is disabled")?;
    if require_active && (policy["enabled"] != true || policy["paused"] == true) {
        return Err("mission capture is disabled or paused".into());
    }
    if !string_set(&policy, "tabIds")?.contains(tab) {
        return Err("tab is outside the selected capture scope".into());
    }
    let deny = string_set(&policy, "excludedHosts")?
        .into_iter()
        .collect::<Vec<_>>()
        .join("\n");
    if !crate::shots::capture_allowed(&deny, url) {
        return Err("page is excluded from mission capture".into());
    }
    Ok(policy)
}

pub fn capture_admission(db: &Database, m: &str, tab: &str, url: &str) -> Result<Value, String> {
    let policy = capture_scope_policy(db, m, tab, url)?;
    let c = db.lock_conn();
    let (queued,bytes):(u64,u64)=c.query_row("SELECT COALESCE(SUM(json_extract(body,'$.status') IN ('queued','capturing','processing')),0),COALESCE(SUM(json_extract(body,'$.byteSize')),0) FROM mission_records WHERE mission_id=?1 AND kind='capture' AND json_extract(body,'$.status')!='expired' AND json_extract(body,'$.expiresAt')>?2",params![m,now_millis()],|r|Ok((r.get(0)?,r.get(1)?))).map_err(|e|e.to_string())?;
    if queued >= 20 {
        return Err("capture processing queue is full; capture paused by backpressure".into());
    }
    if bytes >= policy["maxBytes"].as_u64().unwrap_or(0) {
        return Err("mission capture storage budget is full".into());
    }
    Ok(policy)
}

pub(crate) fn enqueue_capture(db: &Database, m: &str, capture: Value) -> Result<Value, String> {
    enqueue_capture_with_store(db, m, capture, &|| Ok(()))
}

/// Store media only after final scope/queue/storage admission under the write
/// transaction. Rejected events cannot leave newly copied recording files.
pub(crate) fn enqueue_capture_with_store(
    db: &Database,
    m: &str,
    mut capture: Value,
    store: &dyn Fn() -> Result<(), String>,
) -> Result<Value, String> {
    let tab = required(&capture, "tabId")?.to_string();
    let url = required(&capture, "url")?.to_string();
    let policy = capture_admission(db, m, &tab, &url)?;
    let hash = required(&capture, "contentHash")?.to_string();
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("capture requires a SHA-256 content hash".into());
    }
    let media = required(&capture, "mediaRef")?;
    if !media.starts_with("shot://") || !crate::shots::valid_key(&media[7..]) {
        return Err(
            "installed adapter accepts shot:// references from Redline's screenshot store".into(),
        );
    }
    let start = capture["startedAt"]
        .as_i64()
        .ok_or("capture start is required")?;
    let end = capture["endedAt"]
        .as_i64()
        .ok_or("capture end is required")?;
    if start <= 0 || end < start || end - start > policy["maxDurationMs"].as_i64().unwrap_or(0) {
        return Err("capture exceeds its duration budget".into());
    }
    let bytes = capture["byteSize"]
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or("capture byte size is required")?;
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let current_policy = capture_policy_in(&tx, m, &tab, &url, true)?;
    if current_policy != policy {
        return Err("capture settings changed before persistence".into());
    }
    let existing:Option<String>=tx.query_row("SELECT body FROM mission_records WHERE mission_id=?1 AND kind='capture' AND json_extract(body,'$.contentHash')=?2 AND json_extract(body,'$.status')!='expired' AND json_extract(body,'$.expiresAt')>?3 LIMIT 1",params![m,hash,now_millis()],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if let Some(existing) = existing.filter(|_| capture["adapter"] != "redline-keyframes-v1") {
        return serde_json::from_str(&existing).map_err(|e| e.to_string());
    }
    let used:u64=tx.query_row("SELECT COALESCE(SUM(json_extract(body,'$.byteSize')),0) FROM mission_records WHERE mission_id=?1 AND kind='capture' AND json_extract(body,'$.status')!='expired' AND json_extract(body,'$.expiresAt')>?2",params![m,now_millis()],|r|r.get(0)).map_err(|e|e.to_string())?;
    if used.saturating_add(bytes) > policy["maxBytes"].as_u64().unwrap_or(0) {
        return Err("capture exceeds its storage budget".into());
    }
    let queued: u64 = tx.query_row("SELECT COUNT(*) FROM mission_records WHERE mission_id=?1 AND kind='capture' AND json_extract(body,'$.status') IN ('queued','capturing','processing') AND json_extract(body,'$.expiresAt')>?2",params![m,now_millis()],|r|r.get(0)).map_err(|e|e.to_string())?;
    if queued >= 20 {
        return Err("capture processing queue is full".into());
    }
    if capture["adapter"] == "redline-keyframes-v1" {
        let recent: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM mission_records WHERE mission_id=?1 AND kind='capture' AND json_extract(body,'$.tabId')=?2 AND json_extract(body,'$.adapter')='redline-keyframes-v1' AND created_at>?3)",params![m,tab,now_millis()-10_000],|r|r.get(0)).map_err(|e|e.to_string())?;
        if recent {
            return Err("capture event coalesced during cooldown".into());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    capture["id"] = json!(id);
    capture["missionId"] = json!(m);
    capture["status"] = json!("queued");
    capture["expiresAt"] = json!(end.saturating_add(policy["retentionMs"].as_i64().unwrap_or(0)));
    if capture["adapter"].is_null() {
        capture["adapter"] = json!("redline-shots-v1");
    }
    capture["derivatives"] = Value::Null;
    append(&tx, m, "capture", &id, &capture)?;
    store()?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(capture)
}

pub(crate) fn index_capture(
    db: &Database,
    m: &str,
    id: &str,
    derivatives: Value,
) -> Result<Value, String> {
    required(&derivatives, "extractorVersion")?;
    required(&derivatives, "modelVersion")?;
    if derivatives["local"] != true {
        return Err("capture derivatives must be processed locally".into());
    }
    let confidence = derivatives["confidence"]
        .as_f64()
        .filter(|c| *c >= 0.0 && *c <= 1.0)
        .ok_or("confidence must be 0–1")?;
    let text = format!(
        "{}\n{}\n{}",
        derivatives["ocr"].as_str().unwrap_or(""),
        derivatives["summary"].as_str().unwrap_or(""),
        derivatives["pageText"].as_str().unwrap_or("")
    );
    if text.len() > 32_000 {
        return Err("capture derivatives exceed 32 KB".into());
    }
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let mut capture = get(&tx, m, "capture", id)?.ok_or("capture not found")?;
    if capture["status"] == "expired" || capture["expiresAt"].as_i64().unwrap_or(0) <= now_millis()
    {
        return Err("capture has expired; derivatives cannot resurrect it".into());
    }
    capture_policy_in(
        &tx,
        m,
        capture["tabId"].as_str().unwrap_or(""),
        capture["url"].as_str().unwrap_or(""),
        true,
    )?;
    capture["derivatives"] = derivatives;
    capture["confidence"] = json!(confidence);
    capture["status"] = json!("indexed");
    capture["indexedAt"] = json!(now_millis());
    tx.execute(
        "DELETE FROM mission_derivatives WHERE mission_id=?1 AND capture_id=?2",
        params![m, id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO mission_derivatives(mission_id,capture_id,text) VALUES(?1,?2,?3)",
        params![m, id, text],
    )
    .map_err(|e| e.to_string())?;
    put(&tx, m, "capture", id, &capture)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(capture)
}

/// Legacy single-frame fixture and admission/index microbenchmark adapter.
/// Live capture uses the bounded recorder in `mission_capture`.
#[cfg(test)]
pub fn link_page_capture(
    db: &Database,
    m: &str,
    tab: &str,
    url: &str,
    key: &str,
    bytes: &[u8],
    page_text: &str,
) -> Result<Value, String> {
    let now = now_millis();
    let capture = enqueue_capture(
        db,
        m,
        json!({"tabId":tab,"url":url,"mediaRef":format!("shot://{key}"),"contentHash":sha256_hex(bytes),
        "byteSize":bytes.len(),"startedAt":now,"endedAt":now,"keyframes":[{"at":now,"mediaRef":format!("shot://{key}") }]}),
    )?;
    let id = required(&capture, "id")?;
    index_capture(
        db,
        m,
        id,
        json!({"extractorVersion":"redline-dom-snapshot-v1","modelVersion":"none","local":true,"confidence":1.0,
        "pageText":page_text.chars().take(8_000).collect::<String>(),"ocr":"","summary":"","evidenceKind":"DOM text accompanying a native screenshot","embeddingProvider":null,"embeddingModel":null}),
    )
}

/// Called when the shared screenshot store forgets a key. Clear searchable
/// derivatives too, preserving only the unavailable historical reference.
pub(crate) fn retire_keyframes(capture: &mut Value) {
    if let Some(frames) = capture["keyframes"].as_array_mut() {
        for frame in frames {
            if let Some(fields) = frame.as_object_mut() {
                fields.retain(|key, _| {
                    matches!(key.as_str(), "at" | "url" | "contentHash" | "revision")
                });
            }
            frame["mediaRef"] = Value::Null;
            frame["processingStatus"] = json!("expired");
        }
    }
}

fn capture_export_metadata(mut capture: Value) -> Value {
    capture["derivatives"] = Value::Null;
    if let Some(frames) = capture["keyframes"].as_array_mut() {
        for frame in frames {
            if let Some(fields) = frame.as_object_mut() {
                fields.retain(|key, _| {
                    matches!(
                        key.as_str(),
                        "at" | "url"
                            | "contentHash"
                            | "revision"
                            | "mediaRef"
                            | "sourceShotRef"
                            | "processingStatus"
                            | "byteSize"
                    )
                });
            }
        }
    }
    capture
}

pub fn forget_shot_reference(db: &Database, key: &str) -> Result<(), String> {
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let entries = {
        let mut stmt=tx.prepare("SELECT mission_id,id,body FROM mission_records WHERE kind='capture' AND (json_extract(body,'$.mediaRef')=?1 OR EXISTS (SELECT 1 FROM json_each(body,'$.keyframes') frame WHERE json_extract(frame.value,'$.mediaRef')=?1 OR json_extract(frame.value,'$.sourceShotRef')=?1))").map_err(|e|e.to_string())?;
        let found = stmt
            .query_map(params![format!("shot://{key}")], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        found
    };
    for (mission, id, body) in entries {
        let mut capture: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        capture["status"] = json!("expired");
        capture["mediaRef"] = Value::Null;
        capture["derivatives"] = Value::Null;
        retire_keyframes(&mut capture);
        capture["byteSize"] = json!(0);
        put(&tx, &mission, "capture", &id, &capture)?;
        tx.execute(
            "DELETE FROM mission_derivatives WHERE mission_id=?1 AND capture_id=?2",
            params![mission, id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

fn prune_captures(db: &Database, m: &str) -> Result<Value, String> {
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let mut expired = 0;
    let pending = {
        let mut stmt=tx.prepare("SELECT body FROM mission_records WHERE mission_id=?1 AND kind='capture' AND json_extract(body,'$.status')!='expired' AND json_extract(body,'$.expiresAt')<=?2 LIMIT 500").map_err(|e|e.to_string())?;
        let bodies = stmt
            .query_map(params![m, now_millis()], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        bodies
            .into_iter()
            .map(|s| serde_json::from_str::<Value>(&s).map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?
    };
    for mut capture in pending {
        if capture["status"] != "expired"
            && capture["expiresAt"].as_i64().unwrap_or(0) <= now_millis()
        {
            let id = required(&capture, "id")?.to_string();
            capture["status"] = json!("expired");
            capture["derivatives"] = Value::Null;
            retire_keyframes(&mut capture);
            capture["mediaRef"] = Value::Null;
            capture["byteSize"] = json!(0);
            tx.execute(
                "DELETE FROM mission_derivatives WHERE mission_id=?1 AND capture_id=?2",
                params![m, id],
            )
            .map_err(|e| e.to_string())?;
            put(&tx, m, "capture", &id, &capture)?;
            expired += 1;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(
        json!({"expired":expired,"mediaOwnership":"shared screenshot files remain governed by the global screenshot retention policy"}),
    )
}

pub fn prune_all_captures(db: &Database) -> Result<(), String> {
    let missions = {
        let c = db.lock_conn();
        let mut stmt=c.prepare("SELECT DISTINCT mission_id FROM mission_records WHERE kind='capture' AND json_extract(body,'$.status')!='expired' AND json_extract(body,'$.expiresAt')<=?1 LIMIT 100").map_err(|e|e.to_string())?;
        let entries = stmt
            .query_map(params![now_millis()], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        entries
    };
    for mission in missions {
        prune_captures(db, &mission)?;
    }
    Ok(())
}

fn search_evidence(db: &Database, m: &str, query: &str) -> Result<Value, String> {
    if query.trim().is_empty() || query.len() > 200 {
        return Err("search needs 1–200 bytes".into());
    }
    let c = db.lock_conn();
    let escaped = format!("\"{}\"", query.replace('"', "\"\""));
    let mut stmt=c.prepare("SELECT capture_id,snippet(mission_derivatives,2,'','', ' … ',32) FROM mission_derivatives WHERE mission_derivatives MATCH ?1 AND mission_id=?2 AND capture_id IN (SELECT id FROM mission_records WHERE mission_id=?2 AND kind='capture' AND json_extract(body,'$.expiresAt')>?3 AND json_extract(body,'$.status')='indexed') LIMIT 20").map_err(|e|e.to_string())?;
    let hits = stmt
        .query_map(params![escaped, m, now_millis()], |r| {
            Ok(json!({"captureId":r.get::<_,String>(0)?,"excerpt":r.get::<_,String>(1)?}))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let hits = hits
        .into_iter()
        .filter(|hit| {
            get(&c, m, "capture", hit["captureId"].as_str().unwrap_or(""))
                .ok()
                .flatten()
                .is_some_and(|capture| {
                    capture_policy_in(
                        &c,
                        m,
                        capture["tabId"].as_str().unwrap_or(""),
                        capture["url"].as_str().unwrap_or(""),
                        false,
                    )
                    .is_ok()
                })
        })
        .collect::<Vec<_>>();
    Ok(json!({"captures":hits,"currentJudgments":current_judgments(&c,m)?}))
}

/// Persist a source-linked Bookshelf revision and the prepared delivery in one
/// transaction. The caller may emit UI events only after this returns.
pub fn prepare_handoff(
    db: &Database,
    m: &str,
    destination: &str,
    body: &str,
    message_ids: &[String],
    key: &str,
) -> Result<Value, String> {
    if !["drafter", "plan", "auto"].contains(&destination) {
        return Err("unsupported handoff destination".into());
    }
    if body.trim().is_empty() || body.len() > 256_000 || key.trim().is_empty() {
        return Err("handoff needs a brief (up to 256 KB) and an idempotency key".into());
    }
    let mission = db
        .get_mission(m)
        .map_err(|e| e.to_string())?
        .ok_or("mission not found")?;
    let findings = db.list_findings(m).map_err(|e| e.to_string())?;
    let thread = db.load_mission_thread(m).map_err(|e| e.to_string())?;
    if message_ids
        .iter()
        .any(|id| !thread.iter().any(|msg| &msg.id == id))
    {
        return Err("a handoff message does not belong to this mission".into());
    }
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    if let Some(existing) = keyed_record(&tx, m, "handoff", key, None)? {
        if existing["destination"] != destination || existing["body"] != body {
            return Err("this handoff key already identifies a different brief".into());
        }
        return Ok(existing);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let draft_id = format!("mission-{id}");
    let revision = uuid::Uuid::new_v4().to_string();
    let now = now_millis();
    tx.execute("INSERT INTO drafts(draft_id,title,doc_markdown,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)",params![draft_id,format!("{} — research brief",mission.title),body,now]).map_err(|e|e.to_string())?;
    for finding in &findings {
        tx.execute("INSERT INTO draft_sources(id,draft_id,kind,ref_id,url,title,excerpt,created_at) VALUES(?1,?2,'mission_finding',?3,?4,?5,?6,?7)",
            params![uuid::Uuid::new_v4().to_string(),draft_id,finding.id,finding.source_url,finding.source_title,finding.body,now]).map_err(|e|e.to_string())?;
    }
    let artifact = json!({"id":revision,"missionId":m,"draftId":draft_id,"body":body,"bodyHash":sha256_hex(body.as_bytes()),
        "evidence":findings,"createdAt":now,"previousRevision":latest(&tx,m,"artifact")?.as_ref().and_then(|a|a["id"].as_str())});
    append(&tx, m, "artifact", &revision, &artifact)?;
    let handoff = json!({"id":id,"missionId":m,"workspaceId":m,"sourceConversationId":m,"messageIds":message_ids,
        "artifactRevision":revision,"draftId":draft_id,"destination":destination,"destinationId":Value::Null,"status":"prepared",
        "idempotencyKey":key,"body":body,"createdAt":now,"objective":mission.goal,
        "confirmedDecisions":current_judgments(&tx,m)?,"unresolvedQuestions":rows(&tx,m,"question")?.into_iter().filter(|q|q["status"]=="open" || q["status"]=="deferred").collect::<Vec<_>>()});
    append(&tx, m, "handoff", &id, &handoff)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(handoff)
}

fn claim_handoff(db: &Database, m: &str, id: &str) -> Result<Value, String> {
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let mut handoff = get(&tx, m, "handoff", id)?.ok_or("handoff not found")?;
    if handoff["status"] != "prepared" {
        return Ok(json!({"claimed":false,"handoff":handoff}));
    }
    let token = uuid::Uuid::new_v4().to_string();
    handoff["status"] = json!("launching");
    handoff["claimToken"] = json!(token);
    handoff["claimedAt"] = json!(now_millis());
    put(&tx, m, "handoff", id, &handoff)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(json!({"claimed":true,"claimToken":token,"handoff":handoff}))
}

fn release_handoff(
    db: &Database,
    m: &str,
    id: &str,
    token: &str,
    retryable: bool,
    error: &str,
) -> Result<Value, String> {
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let mut handoff = get(&tx, m, "handoff", id)?.ok_or("handoff not found")?;
    if handoff["status"] != "launching" || handoff["claimToken"] != token {
        return Err("handoff is not owned by this launch attempt".into());
    }
    handoff["status"] = json!(if retryable { "prepared" } else { "uncertain" });
    handoff["error"] = json!(error);
    put(&tx, m, "handoff", id, &handoff)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(handoff)
}

fn deliver_handoff(
    db: &Database,
    m: &str,
    id: &str,
    destination_id: &str,
    claim_token: Option<&str>,
) -> Result<Value, String> {
    if destination_id.trim().is_empty() {
        return Err("a concrete destination ID is required".into());
    }
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let mut handoff = get(&tx, m, "handoff", id)?.ok_or("handoff not found")?;
    if handoff["status"] == "delivered" {
        if handoff["destinationId"] == destination_id {
            return Ok(handoff);
        }
        return Err("this brief was already delivered to another destination".into());
    }
    if handoff["destination"] != "drafter"
        && (handoff["status"] != "launching"
            || handoff["claimToken"].as_str() != claim_token
            || claim_token.is_none())
    {
        return Err("claim this handoff before launching and supply its claim token with the delivery receipt".into());
    }
    handoff["status"] = json!("delivered");
    handoff["destinationId"] = json!(destination_id);
    handoff["deliveredAt"] = json!(now_millis());
    put(&tx, m, "handoff", id, &handoff)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(handoff)
}

fn conversation_table(kind: &str) -> Result<(&'static str, &'static str), String> {
    match kind {
        "browse" => Ok(("browse_messages", "browse_id")),
        "linked" => Ok(("linked_messages", "linked_id")),
        "companion" => Ok(("companion_messages", "companion_id")),
        "drafter" => Ok(("draft_chat_messages", "draft_id")),
        _ => Err("unsupported conversation kind; use browse, linked, companion, or drafter".into()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationHandoffRequest {
    pub conversation_kind: String,
    pub conversation_id: String,
    pub message_ids: Vec<String>,
    pub destination: String,
    pub body: String,
    pub idempotency_key: String,
}

fn prepare_conversation_handoff(
    db: &Database,
    request: ConversationHandoffRequest,
) -> Result<Value, String> {
    let (table, column) = conversation_table(&request.conversation_kind)?;
    if request.message_ids.is_empty() || request.message_ids.len() > 100 {
        return Err(
            "select 1–100 completed source messages before preparing a conversation handoff".into(),
        );
    }
    if !["drafter", "plan", "auto"].contains(&request.destination.as_str())
        || request.body.trim().is_empty()
        || request.body.len() > 256_000
        || request.idempotency_key.is_empty()
    {
        return Err(
            "choose a supported destination and provide a bounded brief with an idempotency key"
                .into(),
        );
    }
    let scope = format!(
        "conversation:{}:{}",
        request.conversation_kind, request.conversation_id
    );
    let mut c = db.lock_conn();
    let tx = c.transaction().map_err(|e| e.to_string())?;
    let existing:Option<String>=tx.query_row("SELECT body FROM mission_records WHERE mission_id=?1 AND kind='handoff' AND json_extract(body,'$.idempotencyKey')=?2",params![scope,request.idempotency_key],|r|r.get(0)).optional().map_err(|e|e.to_string())?;
    if let Some(existing) = existing {
        let saved: Value = serde_json::from_str(&existing).map_err(|e| e.to_string())?;
        if saved["body"] != request.body || saved["destination"] != request.destination {
            return Err("handoff key belongs to a different prepared brief".into());
        }
        return Ok(saved);
    }
    let thread = {
        let selected_ids =
            serde_json::to_string(&request.message_ids).map_err(|e| e.to_string())?;
        let mut stmt=tx.prepare(&format!("SELECT id,role,body,created_at FROM {table} WHERE {column}=?1 AND status='complete' AND id IN (SELECT value FROM json_each(?2)) ORDER BY created_at,rowid")).map_err(|e|e.to_string())?;
        let result=stmt.query_map(params![request.conversation_id,selected_ids],|r|Ok(json!({"id":r.get::<_,String>(0)?,"role":r.get::<_,String>(1)?,"body":r.get::<_,String>(2)?,"createdAt":r.get::<_,i64>(3)?}))).map_err(|e|e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e|e.to_string())?;
        result
    };
    if thread.is_empty() {
        return Err("source conversation has no completed messages".into());
    }
    if request
        .message_ids
        .iter()
        .any(|id| !thread.iter().any(|msg| msg["id"] == *id))
    {
        return Err(
            "selected messages must belong to the source conversation and be complete".into(),
        );
    }
    let selected: Vec<Value> = thread
        .into_iter()
        .filter(|msg| request.message_ids.iter().any(|id| msg["id"] == *id))
        .collect();
    let ids: Vec<String> = selected
        .iter()
        .filter_map(|msg| msg["id"].as_str().map(str::to_string))
        .collect();
    let id = uuid::Uuid::new_v4().to_string();
    let draft_id = format!("conversation-{id}");
    let revision = uuid::Uuid::new_v4().to_string();
    let now = now_millis();
    let brief_title = if request.conversation_kind == "companion" {
        tx.query_row("SELECT title FROM companions WHERE companion_id = ?1", params![request.conversation_id], |row| row.get::<_, String>(0)).ok().map(|title| format!("Brief · {title}"))
    } else { None }.unwrap_or_else(|| "Conversation brief".into());
    tx.execute("INSERT INTO drafts(draft_id,title,doc_markdown,created_at,updated_at) VALUES(?1,?2,?3,?4,?4)",params![draft_id,brief_title,request.body,now]).map_err(|e|e.to_string())?;
    for msg in &selected {
        tx.execute("INSERT INTO draft_sources(id,draft_id,kind,ref_id,title,excerpt,created_at) VALUES(?1,?2,'digest',?3,?4,?5,?6)",params![uuid::Uuid::new_v4().to_string(),draft_id,msg["id"].as_str(),format!("{} conversation · {}",request.conversation_kind,msg["role"].as_str().unwrap_or("message")),msg["body"].as_str(),now]).map_err(|e|e.to_string())?;
    }
    append(
        &tx,
        &scope,
        "artifact",
        &revision,
        &json!({"id":revision,"draftId":draft_id,"body":request.body,"bodyHash":sha256_hex(request.body.as_bytes()),"sourceMessages":selected,"createdAt":now}),
    )?;
    let handoff = json!({"id":id,"scopeId":scope,"missionId":Value::Null,"workspaceId":scope,
        "sourceConversationKind":request.conversation_kind,"sourceConversationId":request.conversation_id,"messageIds":ids,
        "artifactRevision":revision,"draftId":draft_id,"destination":request.destination,"destinationId":Value::Null,
        "status":"prepared","body":request.body,"idempotencyKey":request.idempotency_key,"createdAt":now,
        "decisionPolicy":"The editable brief distinguishes confirmed user decisions, assistant suggestions, rejected directions and unresolved ideas; quoted source messages retain their roles."});
    append(&tx, &scope, "handoff", &id, &handoff)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(handoff)
}

#[tauri::command]
pub async fn conversation_prepare_handoff(
    mission: tauri::State<'_, crate::mission::MissionState>,
    request: ConversationHandoffRequest,
) -> Result<Value, String> {
    let db = mission.db.clone();
    tokio::task::spawn_blocking(move || prepare_conversation_handoff(&db, request))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Database {
        let db = Database::open_in_memory().unwrap();
        initialize(&db).unwrap();
        for id in ["m1", "m2"] {
            db.insert_mission(&crate::state::Mission{mission_id:id.into(),title:"Securities Dev".into(),goal:"Monitor investigations; distinguish announcements from filed cases and verify dates".into(),status:"active".into(),created_at:1,updated_at:1}).unwrap();
        }
        db
    }
    fn publish_all(db: &Database) -> PublishedContext {
        publish(
            db,
            "m1",
            [
                "mandate",
                "artifact",
                "evidence",
                "judgments",
                "procedure",
                "runHistory",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            true,
        )
        .unwrap()
    }
    fn identity() -> RunIdentity {
        serde_json::from_value(json!({"model":{"provider":"fixture","model":"securities-v1","local":true,"capabilities":["text","structured-output"],"contextLimit":8192},"execution":{"environmentId":"computer-one","workspaceId":"m1","allowedTools":["read","fetch"],"allowedHosts":["firm-a.test","firm-b.test"],"credentialRefs":[],"maxActions":50,"maxSeconds":120}})).unwrap()
    }
    fn bot(db: &Database, version: &str) -> Value {
        create_bot(db,"m1",json!({"name":"Securities Dev","mandate":"New investigations, filed complaints and verified published deadlines","cadence":"daily","timeZone":"America/Los_Angeles","contextMode":"follow","versionId":version,"contextScope":["mandate","evidence","judgments"],"allowedTools":["read","fetch"],"allowedHosts":["firm-a.test","firm-b.test"]})).unwrap()
    }
    fn finding() -> Value {
        json!({"body":"Example issuer investigation announced; a filed action has not been verified.","fingerprint":"example-issuer|investigation|2026-09-10","relevance":"Within the configured securities investigation mandate","scope":"Example issuer September 2026 investigation","sources":[{"url":"https://firm-a.test/investigation","title":"Firm A announcement","excerpt":"Firm A announces an investigation. No complaint or deadline is provided.","publishedAt":1788998400000i64,"observedAt":1789084800000i64}]})
    }
    #[test]
    fn frontend_and_runtime_requests_deserialize_with_camel_case_fields() {
        let request=parse_request(json!({"missionId":"m1","workspaceId":"m1","op":"publish","scope":["mandate"],"localOnly":true})).unwrap();
        assert!(matches!(
            request.action,
            FoundationAction::Publish {
                local_only: true,
                ..
            }
        ));
        let request=parse_request(json!({"missionId":"m1","workspaceId":"m1","op":"resolveQuestion","questionId":"q1","action":"defer","explanation":"","supersedes":null})).unwrap();
        assert!(matches!(
            request.action,
            FoundationAction::ResolveQuestion { .. }
        ));
        let request=parse_request(json!({"missionId":"m1","workspaceId":"m1","op":"startRun","botId":"bot1","idempotencyKey":"day1","identity":identity()})).unwrap();
        assert!(matches!(request.action, FoundationAction::StartRun { .. }));
        for invalid in [
            json!({"missionId":"m1","workspaceId":"m1","op":"unknown"}),
            json!({"missionId":"m1","op":"read"}),
            json!({"missionId":"m1","workspaceId":"m1","op":"publish","scope":"mandate","localOnly":true}),
        ] {
            assert!(parse_request(invalid).is_err());
        }
    }
    #[test]
    fn published_capture_metadata_does_not_copy_regenerable_frame_text() {
        let metadata = capture_export_metadata(
            json!({"id":"segment","derivatives":{"ocr":"secret"},"keyframes":[{"at":1,"url":"https://source.test","mediaRef":"shot://mc-frame","contentHash":"hash","revision":"r1","ocr":"secret","pageText":"private DOM","summary":"private summary","regions":[{"text":"secret"}]}]}),
        );
        assert!(metadata["derivatives"].is_null());
        let frame = &metadata["keyframes"][0];
        assert_eq!(frame["mediaRef"], "shot://mc-frame");
        assert_eq!(frame["contentHash"], "hash");
        for field in ["ocr", "pageText", "summary", "regions"] {
            assert!(frame.get(field).is_none());
        }
    }
    #[test]
    fn securities_revisions_runs_dedup_and_confirmed_corrections() {
        let db = db();
        let first = publish_all(&db);
        let b = bot(&db, &first.version_id);
        let run = start_run(
            &db,
            "m1",
            b["id"].as_str().unwrap(),
            "2026-09-10",
            identity(),
        )
        .unwrap();
        let id = run["id"].as_str().unwrap();
        assert_eq!(
            start_run(
                &db,
                "m1",
                b["id"].as_str().unwrap(),
                "2026-09-10",
                identity()
            )
            .unwrap(),
            run
        );
        let saved = ingest_finding(&db, "m1", id, finding()).unwrap();
        assert_eq!(
            ingest_finding(&db, "m1", id, finding()).unwrap()["duplicate"],
            true
        );
        assert_eq!(db.list_findings("m1").unwrap().len(), 1);
        let qid = format!("finding-{}", saved["findingId"].as_str().unwrap());
        resolve_question(
            &db,
            "m1",
            &qid,
            "defer",
            "Verify whether a complaint exists",
            None,
        )
        .unwrap();
        assert!(current_judgments(&db.lock_conn(), "m1").unwrap().is_empty());
        resolve_question(
            &db,
            "m1",
            &qid,
            "correct",
            "An investigation announcement is not evidence of a filed case.",
            None,
        )
        .unwrap();
        let second = publish_all(&db);
        assert_eq!(
            resolve(&db, "m1", &first.version_id).unwrap().manifest_hash,
            first.manifest_hash
        );
        assert_ne!(second.manifest_hash, first.manifest_hash);
        assert!(serde_json::to_string(&second.assets["judgments"])
            .unwrap()
            .contains("not evidence of a filed case"));
        assert_eq!(
            get(&db.lock_conn(), "m1", "run", id).unwrap().unwrap()["versionId"],
            first.version_id
        );
        update_run(&db,"m1",id,Some("partial"),json!({"checkedSources":["firm-a.test"],"failedSources":["firm-b.test"],"summary":"One of two sources failed; no complete coverage claim."})).unwrap();
        let mut replacement = identity();
        replacement.model.model = "securities-v2".into();
        replacement.execution.environment_id = "computer-two".into();
        let newer = start_run(
            &db,
            "m1",
            b["id"].as_str().unwrap(),
            "2026-09-11",
            replacement,
        )
        .unwrap();
        assert_eq!(newer["versionId"], second.version_id);
        assert_eq!(
            ingest_finding(&db, "m1", newer["id"].as_str().unwrap(), finding()).unwrap()
                ["duplicate"],
            true
        );
        assert_eq!(db.list_findings("m2").unwrap().len(), 0);
        assert!(db.verify_ledger_chain().unwrap().ok);
    }
    #[test]
    fn manifest_tampering_and_scope_mismatch_are_rejected() {
        let db = db();
        let mut published = publish_all(&db);
        published.assets.get_mut("mandate").unwrap().content = Some(json!({"goal":"tampered"}));
        assert!(verify_context(&published).is_err());
        // Even an attacker recomputing the outer manifest cannot hide an
        // unchanged asset digest.
        published.manifest_hash = context_hash(&published).unwrap();
        assert!(verify_context(&published).is_err());
        assert!(validate_scope(&db, "m1", "m2").is_err());
        let context = publish_all(&db);
        assert!(db
            .lock_conn()
            .execute(
                "UPDATE mission_records SET body='{}' WHERE kind='context' AND id=?1",
                params![context.version_id]
            )
            .is_err());
    }
    #[test]
    fn lifecycle_recovery_and_handoff_are_durable_and_idempotent() {
        let db = db();
        checkpoint(&db, "m1", "researching", "Verify firm sources", None, true).unwrap();
        recover_interrupted(&db).unwrap();
        assert_eq!(db.get_mission("m1").unwrap().unwrap().status, "interrupted");
        let a = prepare_handoff(
            &db,
            "m1",
            "drafter",
            "# Objective\nMonitor verified filings.",
            &[],
            "brief-one",
        )
        .unwrap();
        let b = prepare_handoff(
            &db,
            "m1",
            "drafter",
            "# Objective\nMonitor verified filings.",
            &[],
            "brief-one",
        )
        .unwrap();
        assert_eq!(a, b);
        assert_eq!(db.list_drafts().unwrap().len(), 1);
        let h = a["id"].as_str().unwrap();
        let d = a["draftId"].as_str().unwrap();
        assert_eq!(
            deliver_handoff(&db, "m1", h, d, None).unwrap()["status"],
            "delivered"
        );
        assert!(deliver_handoff(&db, "m1", h, d, None).is_ok());
        assert!(deliver_handoff(&db, "m1", h, "different-session", None).is_err());
        assert!(prepare_handoff(&db, "m1", "auto", "changed", &[], "brief-one").is_err());
    }
    #[test]
    fn launch_claim_prevents_concurrent_or_uncertain_replay() {
        let db = db();
        let handoff = prepare_handoff(&db, "m1", "plan", "# Plan", &[], "plan-one").unwrap();
        let id = handoff["id"].as_str().unwrap();
        let claim = claim_handoff(&db, "m1", id).unwrap();
        assert_eq!(claim["claimed"], true);
        assert_eq!(claim_handoff(&db, "m1", id).unwrap()["claimed"], false);
        assert!(deliver_handoff(&db, "m1", id, "session-one", None).is_err());
        let token = claim["claimToken"].as_str().unwrap();
        release_handoff(&db, "m1", id, token, false, "spawn outcome is unknown").unwrap();
        assert_eq!(claim_handoff(&db, "m1", id).unwrap()["claimed"], false);
        assert!(deliver_handoff(&db, "m1", id, "session-one", Some(token)).is_err());
    }
    #[test]
    fn dismissed_and_deferred_observations_do_not_invent_user_judgment() {
        let db = db();
        let q=observe(&db,"m1",json!({"id":"skip-1","action":"Navigated away from an article","url":"https://firm-a.test/news","scope":"issuer-one","observedAt":123})).unwrap();
        resolve_question(&db, "m1", q["id"].as_str().unwrap(), "dismiss", "", None).unwrap();
        assert!(current_judgments(&db.lock_conn(), "m1").unwrap().is_empty());
        let before = db.list_ledger_events_asc(0, 100).unwrap();
        let _ = publish_all(&db);
        initialize(&db).unwrap();
        let after = db.list_ledger_events_asc(0, 100).unwrap();
        assert_eq!(
            before.iter().map(|e| &e.entry_hash).collect::<Vec<_>>(),
            after.iter().map(|e| &e.entry_hash).collect::<Vec<_>>()
        );
        assert!(db.verify_ledger_chain().unwrap().ok);
    }
    #[test]
    fn capture_exclusions_backpressure_and_pruning_bound_retrieval() {
        let db = db();
        configure_capture(&db,"m1",json!({"enabled":true,"paused":false,"tabIds":["tab1"],"excludedHosts":["private.test"],"maxDurationMs":15000,"maxBytes":1000000,"retentionMs":60000,"localOnly":true})).unwrap();
        assert!(capture_admission(&db, "m1", "tab1", "https://mail.private.test/a").is_err());
        assert!(capture_admission(&db, "m1", "tab2", "https://firm-a.test").is_err());
        let now = now_millis();
        let capture=enqueue_capture(&db,"m1",json!({"tabId":"tab1","url":"https://firm-a.test","contentHash":sha256_hex(b"pixels"),"mediaRef":"shot://bs-fixture","byteSize":500,"startedAt":now,"endedAt":now})).unwrap();
        let id = capture["id"].as_str().unwrap();
        index_capture(&db,"m1",id,json!({"extractorVersion":"fixture-ocr-v1","modelVersion":"local-v1","local":true,"confidence":0.9,"ocr":"Verified announcement","summary":"An investigation announcement"})).unwrap();
        assert_eq!(
            search_evidence(&db, "m1", "announcement").unwrap()["captures"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let mut expired = capture;
        expired["expiresAt"] = json!(now - 1);
        put(
            &db.lock_conn(),
            "m1",
            "capture",
            expired["id"].as_str().unwrap(),
            &expired,
        )
        .unwrap();
        assert_eq!(prune_captures(&db, "m1").unwrap()["expired"], 1);
        assert!(
            search_evidence(&db, "m1", "announcement").unwrap()["captures"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn forgetting_shared_screenshot_removes_derived_search_content() {
        let db = db();
        configure_capture(&db,"m1",json!({"enabled":true,"paused":false,"tabIds":["tab1"],"excludedHosts":[],"maxDurationMs":15000,"maxBytes":1000000,"retentionMs":60000,"localOnly":true})).unwrap();
        link_page_capture(
            &db,
            "m1",
            "tab1",
            "https://firm-a.test",
            "bs-forget",
            b"pixels",
            "Important visual context",
        )
        .unwrap();
        assert_eq!(
            search_evidence(&db, "m1", "Important").unwrap()["captures"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        forget_shot_reference(&db, "bs-forget").unwrap();
        assert!(search_evidence(&db, "m1", "Important").unwrap()["captures"]
            .as_array()
            .unwrap()
            .is_empty());
        let captures = rows(&db.lock_conn(), "m1", "capture").unwrap();
        assert_eq!(captures[0]["status"], "expired");
    }
    #[test]
    fn headless_consumer_verifies_the_real_rust_manifest() {
        let db = db();
        let context = publish_all(&db);
        let path = std::env::temp_dir().join(format!(
            "redline-mission-context-{}.json",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, serde_json::to_vec(&context).unwrap()).unwrap();
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/mission-reference-consumer.py");
        let result = std::process::Command::new("python3")
            .arg(script)
            .arg("--verify")
            .arg(&path)
            .output();
        let _ = std::fs::remove_file(path);
        let output =
            result.expect("python3 is required for the headless contract conformance check");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("\"verified\": true"));
    }
    #[test]
    fn conversation_handoff_preserves_source_identity_without_creating_a_mission() {
        let db = db();
        db.lock_conn().execute("INSERT INTO browse_messages(id,browse_id,role,body,status,created_at) VALUES('msg1','browser-thread','user','Keep a source-linked brief','complete',1)",[]).unwrap();
        let h = prepare_conversation_handoff(
            &db,
            ConversationHandoffRequest {
                conversation_kind: "browse".into(),
                conversation_id: "browser-thread".into(),
                message_ids: vec!["msg1".into()],
                destination: "plan".into(),
                body: "# Brief\nKeep source links".into(),
                idempotency_key: "conversation-brief".into(),
            },
        )
        .unwrap();
        assert_eq!(h["sourceConversationId"], "browser-thread");
        assert!(h["missionId"].is_null());
        let scope = h["scopeId"].as_str().unwrap();
        validate_handoff_scope(&db, scope, scope).unwrap();
        assert_eq!(
            claim_handoff(&db, scope, h["id"].as_str().unwrap()).unwrap()["claimed"],
            true
        );
        assert_eq!(db.list_missions().unwrap().len(), 2);
    }

    #[test]
    #[ignore = "explicit local capture-interface microbenchmark, not a native navigation benchmark"]
    fn capture_interface_microbenchmark() {
        let db = db();
        let allocated = || -> u64 {
            let c = db.lock_conn();
            let pages: u64 = c.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
            let size: u64 = c.query_row("PRAGMA page_size", [], |r| r.get(0)).unwrap();
            pages * size
        };
        let mut disabled = Vec::new();
        let mut enabled = Vec::new();
        for _ in 0..100 {
            let start = std::time::Instant::now();
            assert!(capture_admission(&db, "m1", "tab1", "https://firm-a.test").is_err());
            disabled.push(start.elapsed().as_micros());
        }
        configure_capture(&db,"m1",json!({"enabled":true,"paused":false,"tabIds":["tab1"],"excludedHosts":[],"maxDurationMs":15000,"maxBytes":1000000,"retentionMs":60000,"localOnly":true})).unwrap();
        let before_bytes = allocated();
        for i in 0..100 {
            let start = std::time::Instant::now();
            link_page_capture(
                &db,
                "m1",
                "tab1",
                "https://firm-a.test",
                &format!("bs-bench-{i}"),
                format!("pixels-{i}").as_bytes(),
                "Bounded DOM context",
            )
            .unwrap();
            enabled.push(start.elapsed().as_micros());
        }
        disabled.sort_unstable();
        enabled.sort_unstable();
        let simulated_bytes = rows(&db.lock_conn(), "m1", "capture")
            .unwrap()
            .iter()
            .map(|c| c["byteSize"].as_u64().unwrap_or(0))
            .sum::<u64>();
        let after_bytes = allocated();
        println!("capture interface only, 100 samples: disabled p50={}us p75={}us p95={}us; enabled admission+persist+FTS p50={}us p75={}us p95={}us; simulated_pixel_bytes={}; sqlite_allocation_before={}; sqlite_allocation_after={}",disabled[49],disabled[74],disabled[94],enabled[49],enabled[74],enabled[94],simulated_bytes,before_bytes,after_bytes);
    }
}
