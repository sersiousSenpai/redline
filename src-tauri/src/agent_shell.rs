// SPDX-License-Identifier: Apache-2.0
//! Foreground hosted sessions. One driver per session; bounded, acknowledged
//! Channel delivery; the original prompt never acquires hidden context text.
use crate::shell_events::{normalize, normalize_codex, ShellEvent};
use crate::state::{AttachState, SessionStore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

const REPLAY_BYTES: usize = 2 * 1024 * 1024;
const IN_FLIGHT: u64 = 256;
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    pub cwd: Option<String>,
    pub prompt: String,
    pub session_id: Option<String>,
    #[serde(default = "default_mode")]
    pub permission_mode: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    #[serde(default)]
    pub add_dirs: Vec<String>,
    pub launch_id: Option<String>,
    #[serde(default)]
    pub restore: bool,
    #[serde(default)]
    pub restore_primed: bool,
    #[serde(default)]
    pub restore_rescinded: bool,
    pub backend: Option<String>,
    pub settings_path: Option<String>,
}
fn default_mode() -> String {
    "default".into()
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub driver_id: String,
    pub id: String,
    pub session_id: String,
    pub cwd: String,
    pub alive: bool,
    pub busy: bool,
    pub raw: bool,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Batch {
    pub events: Vec<ShellEvent>,
    pub alive: bool,
    pub busy: bool,
}
struct Subscriber {
    token: String,
    channel: Channel<Batch>,
    sent: u64,
    ack: u64,
}
#[derive(Default)]
struct Output {
    events: VecDeque<ShellEvent>,
    seq: u64,
    bytes: usize,
    subscriber: Option<Subscriber>,
}
struct Session {
    driver_id: String,
    id: String,
    sid: Mutex<String>,
    cwd: String,
    request: Launch,
    output: Mutex<Output>,
    alive: AtomicBool,
    busy: AtomicBool,
    raw: AtomicBool,
    writer: tokio::sync::mpsc::Sender<Value>,
    stop: tokio::sync::Notify,
    permissions: Mutex<HashMap<String, Value>>,
    rpc: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Result<Value, String>>>>,
    last_journal: Mutex<i64>,
    pid: Mutex<Option<u32>>,
}
impl Session {
    fn event(&self, mut event: ShellEvent) {
        let mut output = self.output.lock().unwrap_or_else(|e| e.into_inner());
        output.seq += 1;
        event.seq = output.seq;
        let size = serde_json::to_vec(&event)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
        if size > REPLAY_BYTES / 2 {
            event.data = json!({"text":"Output exceeded the display limit. Open the raw event inspector for details.","truncated":true});
        }
        output.bytes += serde_json::to_vec(&event)
            .map(|bytes| bytes.len())
            .unwrap_or(0);
        output.events.push_back(event);
        while output.bytes > REPLAY_BYTES || output.events.len() > 4096 {
            if let Some(old) = output.events.pop_front() {
                output.bytes = output.bytes.saturating_sub(
                    serde_json::to_vec(&old)
                        .map(|bytes| bytes.len())
                        .unwrap_or(0),
                );
            } else {
                break;
            }
        }
    }
    fn flush(&self) {
        let mut output = self.output.lock().unwrap_or_else(|e| e.into_inner());
        let Some(subscriber) = output.subscriber.as_ref() else {
            return;
        };
        if subscriber.sent.saturating_sub(subscriber.ack) >= IN_FLIGHT {
            return;
        }
        let events: Vec<_> = output
            .events
            .iter()
            .filter(|event| event.seq > subscriber.sent)
            .take((IN_FLIGHT - subscriber.sent.saturating_sub(subscriber.ack)) as usize)
            .cloned()
            .collect();
        if events.is_empty() {
            return;
        }
        let last = events.last().unwrap().seq;
        let batch = Batch {
            events,
            alive: self.alive.load(Ordering::Acquire),
            busy: self.busy.load(Ordering::Acquire),
        };
        if subscriber.channel.send(batch).is_ok() {
            if let Some(subscriber) = output.subscriber.as_mut() {
                subscriber.sent = last;
            }
        } else {
            output.subscriber = None;
        }
    }
    fn info(&self) -> Info {
        Info {
            driver_id: self.driver_id.clone(),
            id: self.id.clone(),
            session_id: self.sid.lock().unwrap().clone(),
            cwd: self.cwd.clone(),
            alive: self.alive.load(Ordering::Acquire),
            busy: self.busy.load(Ordering::Acquire),
            raw: self.raw.load(Ordering::Acquire),
        }
    }
}
struct BusyReservation {
    session: Arc<Session>,
    committed: bool,
}
impl BusyReservation {
    fn acquire(session: Arc<Session>) -> Result<Self, String> {
        session
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "This session is still working; wait for it to finish".to_string())?;
        Ok(Self {
            session,
            committed: false,
        })
    }
}
impl Drop for BusyReservation {
    fn drop(&mut self) {
        if !self.committed {
            self.session.busy.store(false, Ordering::Release);
        }
    }
}

#[derive(Clone, Default)]
pub struct AgentShellState(Arc<Mutex<HashMap<String, Arc<Session>>>>);
static PIDS: OnceLock<Mutex<HashMap<u32, String>>> = OnceLock::new();
static CONTEXT: OnceLock<Mutex<HashMap<String, VecDeque<Value>>>> = OnceLock::new();
pub fn hosted_pids() -> HashMap<u32, String> {
    PIDS.get_or_init(Default::default).lock().unwrap().clone()
}
pub fn is_hosted(id: &str) -> bool {
    hosted_pids().values().any(|value| value == id)
}
pub fn take_context(session_id: &str) -> Option<Value> {
    let mut all = CONTEXT.get_or_init(Default::default).lock().unwrap();
    let queue = all.get_mut(session_id)?;
    let context = queue.pop_front().filter(|value| !value.is_null());
    if queue.is_empty() {
        all.remove(session_id);
    }
    context
}
fn queue_context(session_id: &str, items: &[Value]) {
    let text = items
        .iter()
        .map(|item| {
            format!(
                "{} [{}]\n{}",
                item["label"].as_str().unwrap_or("Context"),
                item["origin"].as_str().unwrap_or("Redline"),
                item["body"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let mut context = CONTEXT.get_or_init(Default::default).lock().unwrap();
    let queue = context.entry(session_id.into()).or_default();
    if queue.len() < 6 {
        queue.push_back(if text.is_empty() { Value::Null } else { json!({"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":text}}) });
    }
}
impl AgentShellState {
    fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.0
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or_else(|| "Hosted session not found".into())
    }
    pub fn kill_all(&self) {
        for session in self.0.lock().unwrap().values() {
            kill(session);
            #[cfg(unix)]
            if let Some(pid) = *session.pid.lock().unwrap() {
                unsafe {
                    libc::kill(-(pid as i32), libc::SIGKILL);
                }
            }
        }
    }
}
fn clear_context(session: &Session) {
    let sid = session.sid.lock().unwrap().clone();
    CONTEXT
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .remove(&sid);
}
fn validate_admission(
    sessions: &HashMap<String, Arc<Session>>,
    id: &str,
    sid: &str,
    replacing: Option<&Arc<Session>>,
) -> Result<(), String> {
    let occupied = |other: &Arc<Session>| {
        let can_replace = replacing.is_some_and(|old| Arc::ptr_eq(old, other))
            && !other.alive.load(Ordering::Acquire)
            && !other.busy.load(Ordering::Acquire)
            && other.pid.lock().unwrap().is_none();
        !can_replace
            && (other.alive.load(Ordering::Acquire)
                || other.busy.load(Ordering::Acquire)
                || other.raw.load(Ordering::Acquire)
                || other.pid.lock().unwrap().is_some())
    };
    if sessions
        .values()
        .any(|other| other.sid.lock().unwrap().as_str() == sid && occupied(other))
    {
        return Err("This conversation already has a live driver".into());
    }
    if sessions.get(id).is_some_and(occupied) {
        return Err("This tab already has a live driver".into());
    }
    Ok(())
}
fn kill(session: &Session) {
    session.alive.store(false, Ordering::Release);
    session.stop.notify_one();
    clear_context(session);
    if let Some(pid) = *session.pid.lock().unwrap() {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
    }
    session.alive.store(false, Ordering::Release);
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn command_args(request: &Launch, sid: &str) -> Result<Vec<String>, String> {
    if !["plan", "default", "manual", "acceptEdits", "auto"]
        .contains(&request.permission_mode.as_str())
    {
        return Err("Unsupported permission mode".into());
    }
    let mut args = vec![
        "-p".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--include-partial-messages".into(),
        "--verbose".into(),
        "--replay-user-messages".into(),
        "--permission-prompts".into(),
        "host".into(),
        "--permission-prompt-tool".into(),
        "stdio".into(),
        "--permission-mode".into(),
        request.permission_mode.clone(),
    ];
    args.push(
        if request.session_id.is_some() {
            "--resume"
        } else {
            "--session-id"
        }
        .into(),
    );
    args.push(sid.into());
    if let Some(model) = &request.model {
        args.extend(["--model".into(), model.clone()]);
    }
    if let Some(effort) = &request.effort {
        args.extend(["--effort".into(), effort.clone()]);
    }
    for dir in &request.add_dirs {
        args.extend(["--add-dir".into(), dir.clone()]);
    }
    if let Some(path) = &request.settings_path {
        args.extend(["--settings".into(), path.clone()]);
    }
    Ok(args)
}
fn user_frame(text: &str) -> Value {
    json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":text}]}})
}
fn control(subtype: &str, fields: Value) -> Value {
    let mut request = fields;
    request["subtype"] = json!(subtype);
    json!({"type":"control_request","request_id":uuid::Uuid::new_v4().to_string(),"request":request})
}

fn record_native_prompt(db: &crate::db::Database, session: &Session, text: &str) {
    use crate::ledger::*;
    let sid = session.sid.lock().unwrap().clone();
    let _ = record_prompt(
        db,
        PromptInput {
            source: PromptSource::Hook,
            origin: Origin::Redline,
            surface: "shell".into(),
            role: CorpusRole::User,
            session_id: Some(sid.clone()),
            claude_session_id: Some(sid.clone()),
            mission_id: None,
            project_path: Some(session.cwd.clone()),
            body: text.into(),
            thread: None,
            author: None,
            model: session.request.model.clone(),
            model_source: session.request.model.as_ref().map(|_| "launch".into()),
            user_text: Some(text.into()),
        },
    );
}
fn shell_books_meter(known_plan: bool, mode: &str) -> bool {
    !known_plan && mode != "plan"
}

#[tauri::command]
pub async fn agent_shell_start(
    state: tauri::State<'_, AgentShellState>,
    app: AppHandle,
    id: String,
    request: Launch,
) -> Result<Info, String> {
    start(state.inner().clone(), app, id, request, None).await
}
async fn start(
    state: AgentShellState,
    app: AppHandle,
    id: String,
    request: Launch,
    replacing: Option<Arc<Session>>,
) -> Result<Info, String> {
    let codex = request.backend.as_deref() == Some("codex");
    if request
        .backend
        .as_deref()
        .is_some_and(|backend| backend != "claude-code" && backend != "codex")
    {
        return Err("This provider needs its native terminal driver".into());
    }
    if request.prompt.len() > 1024 * 1024 {
        return Err("Prompt exceeds the hosted input limit".into());
    }
    let sid = request
        .session_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if !crate::claude_proc::is_plain_session_id(&sid) {
        return Err("Invalid session identifier".into());
    }
    let cwd = request
        .cwd
        .clone()
        .or_else(crate::fsbrowse::home_dir)
        .ok_or("Project directory unavailable")?;
    let cwd = std::fs::canonicalize(cwd)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let args = if codex {
        vec!["app-server".into()]
    } else {
        command_args(&request, &sid)?
    };
    let (writer, mut input) = tokio::sync::mpsc::channel::<Value>(64);
    let session = Arc::new(Session {
        driver_id: uuid::Uuid::new_v4().to_string(),
        id: id.clone(),
        sid: Mutex::new(sid.clone()),
        cwd: cwd.clone(),
        request: request.clone(),
        output: Mutex::new(Output::default()),
        alive: AtomicBool::new(true),
        busy: AtomicBool::new(true),
        raw: AtomicBool::new(false),
        writer,
        stop: tokio::sync::Notify::new(),
        permissions: Mutex::new(HashMap::new()),
        rpc: Mutex::new(HashMap::new()),
        last_journal: Mutex::new(0),
        pid: Mutex::new(None),
    });
    {
        let mut sessions = state.0.lock().unwrap();
        validate_admission(&sessions, &id, &sid, replacing.as_ref())?;
        sessions.insert(id.clone(), session.clone());
    }
    // Register before the first await so closing a tab cancels startup too.
    let binary = match tokio::task::spawn_blocking(move || {
        if codex {
            crate::codex_app_server::resolve_codex_bin()
        } else {
            crate::claude_proc::resolve_claude_bin()
        }
    })
    .await
    {
        Ok(binary) => binary,
        Err(error) => {
            session.alive.store(false, Ordering::Release);
            session.busy.store(false, Ordering::Release);
            return Err(error.to_string());
        }
    };
    if request.session_id.is_some() {
        if let Ok(history) = agent_shell_history(sid.clone(), request.backend.clone()).await {
            for event in history {
                session.event(event);
            }
        }
    }
    if !session.alive.load(Ordering::Acquire) {
        session.busy.store(false, Ordering::Release);
        return Err("The tab closed before its driver started".into());
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let script = format!(
        "exec {} {}",
        quote(&binary),
        args.iter()
            .map(|arg| quote(arg))
            .collect::<Vec<_>>()
            .join(" ")
    );
    let mut command = tokio::process::Command::new(shell);
    command
        .args(["-lc", &script])
        .current_dir(&cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for (key, _) in std::env::vars_os() {
        if key
            .to_str()
            .is_some_and(crate::claude_proc::is_inherited_session_var)
        {
            command.env_remove(key);
        }
    }
    command.env_remove(crate::claude_proc::ENV_AGENT_SEAT);
    command.env(crate::auth::ENV_DAEMON_TOKEN, crate::auth::daemon_token());
    if request.restore {
        command
            .env(
                crate::claude_proc::ENV_AGENT_SEAT,
                crate::restore_context::RESTORE_SEAT,
            )
            .env(crate::restore_context::ENV_TARGET, &sid)
            .env(
                crate::restore_context::ENV_PRIMED,
                if request.restore_primed { "1" } else { "0" },
            )
            .env(
                crate::restore_context::ENV_RESCINDED,
                if request.restore_rescinded { "1" } else { "0" },
            );
    }
    if let Some(launch_id) = &request.launch_id {
        command.env("REDLINE_PLAN_LAUNCH_ID", launch_id);
    }
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            session.alive.store(false, Ordering::Release);
            session.busy.store(false, Ordering::Release);
            return Err(error.to_string());
        }
    };
    let pid = child.id();
    *session.pid.lock().unwrap() = pid;
    if let Some(pid) = pid {
        PIDS.get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(pid, id.clone());
    }
    let mut stdin = child.stdin.take().ok_or("Hosted input unavailable")?;
    let stdout = child.stdout.take().ok_or("Hosted output unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Hosted diagnostics unavailable")?;
    session.event(ShellEvent::new(
        "status",
        json!({"text":if codex {"Starting Codex"} else {"Starting Claude"},"sessionId":sid}),
    ));
    let stderr_session = session.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                stderr_session.event(ShellEvent::new(
                    "diagnostic",
                    json!({"text":line.chars().take(4000).collect::<String>()}),
                ));
            }
        }
    });
    let pump_session = session.clone();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(16));
        loop {
            interval.tick().await;
            pump_session.flush();
            if !pump_session.alive.load(Ordering::Acquire) {
                pump_session.flush();
                break;
            }
        }
    });
    let mut native = codex.then(|| {
        crate::codex_conversation::NativeTurn::new(
            cwd.clone(),
            request.prompt.clone(),
            request.session_id.clone(),
            request.model.clone(),
            request.effort.clone(),
            Value::Null,
        )
        .hosted(&request.permission_mode)
    });
    let initialize = if codex {
        let mut init = crate::codex_conversation::NativeTurn::initialize();
        init["params"]["capabilities"]["experimentalApi"] = json!(true);
        init
    } else {
        control("initialize", json!({}))
    };
    let initial_write = async {
        if !session.alive.load(Ordering::Acquire) {
            return Err("The tab closed before its first prompt was sent".to_string());
        }
        stdin
            .write_all(format!("{initialize}\n").as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        if !request.prompt.is_empty() {
            session.event(ShellEvent::new("user", json!({"text":request.prompt})));
            // The first prompt is byte-identical to the launch registration.
            if !codex {
                let frame = user_frame(&request.prompt);
                stdin
                    .write_all(format!("{frame}\n").as_bytes())
                    .await
                    .map_err(|e| e.to_string())?;
            }
        }
        stdin.flush().await.map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = initial_write {
        if tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        #[cfg(unix)]
        if let Some(pid) = pid {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        session.alive.store(false, Ordering::Release);
        session.busy.store(false, Ordering::Release);
        *session.pid.lock().unwrap() = None;
        if let Some(pid) = pid {
            PIDS.get_or_init(Default::default)
                .lock()
                .unwrap()
                .remove(&pid);
        }
        return Err(error);
    }
    if !codex && request.prompt.is_empty() {
        session.busy.store(false, Ordering::Release);
    }
    let task_session = session.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let partial = Arc::new(Mutex::new(crate::turn::PartialBuf::new()));
        let db = app.state::<SessionStore>().database();
        loop {
            if !task_session.alive.load(Ordering::Acquire) {
                break;
            }
            tokio::select! {
                _ = task_session.stop.notified() => break,
                frame = input.recv() => {
                    let Some(mut frame) = frame else { break; };
                    let original_native_text=if codex && frame["type"]=="user" {frame["message"]["content"][0]["text"].as_str().map(str::to_owned)} else {None};
                    if let Some(native) = native.as_mut() {
                        if frame["type"] == "user" {
                            let text=frame["message"]["content"][0]["text"].as_str().unwrap_or("").to_string();
                            let context_sid=task_session.sid.lock().unwrap().clone();
                            let context=take_context(&context_sid).and_then(|value|value["hookSpecificOutput"]["additionalContext"].as_str().map(str::to_owned)).unwrap_or_default();
                            if !native.completed && native.turn_id.is_some() {task_session.event(ShellEvent::new("error",json!({"text":"Codex is still working"})));continue;}
                            native.set_context(context);
                            match native.next_turn(text) {Ok(next)=>frame=next,Err(error)=>{task_session.busy.store(false,Ordering::Release);task_session.event(ShellEvent::new("error",json!({"text":error})));continue;}}
                        } else if frame["type"] == "control_request" {
                            match frame["request"]["subtype"].as_str().unwrap_or("") {
                                "interrupt"=>frame=json!({"id":uuid::Uuid::new_v4().to_string(),"method":"turn/interrupt","params":{"threadId":native.thread_id,"turnId":native.turn_id}}),
                                "set_permission_mode"=>{native.set_hosted_mode(frame["request"]["mode"].as_str().unwrap_or("default"));continue;},
                                "set_model"=>{native.model=frame["request"]["model"].as_str().map(str::to_owned);continue;},
                                _=>continue,
                            }
                        }
                    }
                    // Codex concatenates input text blocks with no separator in
                    // UserPromptSubmit. Claim that exact synthetic hook body;
                    // record_native_prompt below stores only the human text.
                    if original_native_text.is_some() {if let Some(input)=frame["params"]["input"].as_array(){let hook_body=input.iter().filter_map(|item|item["text"].as_str()).collect::<String>();crate::ledger::register_agent_prompt(&hook_body);}}
                    if stdin.write_all(format!("{frame}\n").as_bytes()).await.is_err() || stdin.flush().await.is_err() { break; }
                    if let Some(text)=original_native_text {record_native_prompt(&db,&task_session,&text);}
                }
                line = lines.next_line() => {
                    let Ok(Some(line)) = line else { break; };
                    let Ok(value) = serde_json::from_str::<Value>(&line) else { continue; };
                    crate::inspect::capture("shell",&id,&line);
                    if let Some(id)=value["id"].as_str() {
                        if let Some(waiter)=task_session.rpc.lock().unwrap().remove(id) {let _=waiter.send(if value.get("error").is_some(){Err(value["error"].to_string())}else{Ok(value["result"].clone())});continue;}
                    }
                    if let Some(native) = native.as_mut() {
                        if value["method"]=="turn/started" {task_session.busy.store(true,Ordering::Release);}
                        if value.get("id").is_some() && value.get("method").is_some() {
                            let method=value["method"].as_str().unwrap_or("");
                            let key=value["id"].to_string();
                            if ["item/commandExecution/requestApproval","item/fileChange/requestApproval","item/tool/requestUserInput"].contains(&method) {
                                let p=&value["params"];
                                let (name,input)=if method=="item/tool/requestUserInput" { ("AskUserQuestion",json!({"questions":p["questions"]})) } else if method.contains("fileChange") { ("Edit",p.clone()) } else { ("Bash",p.clone()) };
                                task_session.permissions.lock().unwrap().insert(key.clone(),json!({"codexId":value["id"],"method":method,"tool_name":name,"input":input}));
                                task_session.event(ShellEvent::new("permission",json!({"requestId":key,"name":name,"input":input,"suggestions":if name=="AskUserQuestion" {json!([])} else {json!(["session"])} }))); continue;
                            }
                        }
                        let step=native.observe(&value);
                        if let Some(thread)=step.thread { *task_session.sid.lock().unwrap()=thread.clone(); if request.prompt.is_empty(){task_session.busy.store(false,Ordering::Release);}
                            if request.launch_id.is_none() && !request.prompt.is_empty(){crate::ledger::register_agent_prompt(&request.prompt);record_native_prompt(&db,&task_session,&request.prompt);} task_session.event(ShellEvent::new("init",json!({"sessionId":thread,"model":native.model}))); }
                        for write in step.writes { if stdin.write_all(format!("{write}\n").as_bytes()).await.is_err() {break;} } let _=stdin.flush().await;
                        if let Some(text)=step.delta {task_session.event(ShellEvent::new("delta",json!({"text":text})));}
                        if let Some(meter)=step.meter {partial.lock().unwrap().meter=meter.clone();task_session.event(ShellEvent::new("meter",json!({"meter":meter})));}
                        for event in normalize_codex(&value) {task_session.event(event);}
                        if step.final_text.is_some() || step.error.is_some() {
                            task_session.busy.store(false,Ordering::Release);
                            task_session.event(ShellEvent::new("complete",json!({"text":step.final_text,"error":step.error.is_some(),"errors":step.error})));
                            if !app.state::<SessionStore>().list().iter().any(|plan|plan.session_id==task_session.sid.lock().unwrap().as_str()) {crate::meter::settle(&db,"hosted-shell",&partial);}
                            *partial.lock().unwrap()=crate::turn::PartialBuf::new();
                        }
                        continue;
                    }
                    if value["type"]=="control_cancel_request" {if let Some(request_id)=value["request_id"].as_str(){task_session.permissions.lock().unwrap().remove(request_id);task_session.event(ShellEvent::new("permission-resolved",json!({"requestId":request_id,"decision":"cancelled"})));}}
                    if value["type"] == "control_request" && value["request"]["subtype"] == "can_use_tool" {
                        if let Some(request_id) = value["request_id"].as_str() { task_session.permissions.lock().unwrap().insert(request_id.into(),value["request"].clone()); }
                    }
                    if let Some(payload) = crate::turn::push_meta(&partial,&value) { task_session.event(ShellEvent::new("meter",json!({"meter":payload.meter}))); }
                    for event in normalize(&value) { task_session.event(event); }
                    if value["type"] == "result" {
                        let pending:Vec<_>=task_session.permissions.lock().unwrap().drain().map(|(id,_)|id).collect();for request_id in pending{task_session.event(ShellEvent::new("permission-resolved",json!({"requestId":request_id,"decision":"cancelled"})));}
                        task_session.busy.store(false,Ordering::Release);
                        // Plan transcripts have exactly one booker: plan_meter.
                        if shell_books_meter(app.state::<SessionStore>().list().iter().any(|plan| plan.session_id == sid),&request.permission_mode) {
                            crate::meter::settle(&db,"hosted-shell",&partial);
                        }
                        *partial.lock().unwrap() = crate::turn::PartialBuf::new();
                    }
                }
            }
            if !task_session.alive.load(Ordering::Acquire) {
                break;
            }
        }
        #[cfg(unix)]
        if let Some(pid) = pid {
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
        let _ = child.kill().await;
        let _ = child.wait().await;
        clear_context(&task_session);
        task_session.alive.store(false, Ordering::Release);
        task_session.busy.store(false, Ordering::Release);
        if let Some(pid) = pid {
            PIDS.get_or_init(Default::default)
                .lock()
                .unwrap()
                .remove(&pid);
        }
        *task_session.pid.lock().unwrap() = None;
        for (_, waiter) in task_session.rpc.lock().unwrap().drain() {
            let _ = waiter.send(Err("Hosted driver stopped".into()));
        }
        task_session.event(ShellEvent::new(
            "exit",
            json!({"text":"Session driver stopped"}),
        ));
        task_session.flush();
    });
    Ok(session.info())
}

async fn native_rpc(session: &Session, method: &str, params: Value) -> Result<Value, String> {
    let id = format!("shell-rpc-{}", uuid::Uuid::new_v4());
    let (tx, rx) = tokio::sync::oneshot::channel();
    session.rpc.lock().unwrap().insert(id.clone(), tx);
    if session
        .writer
        .send(json!({"id":id,"method":method,"params":params}))
        .await
        .is_err()
    {
        session.rpc.lock().unwrap().remove(&id);
        return Err("Hosted driver stopped".into());
    }
    let result = tokio::time::timeout(Duration::from_secs(8), rx)
        .await
        .map_err(|_| "Codex approval acknowledgement timed out".to_string())
        .and_then(|reply| reply.map_err(|_| "Hosted driver stopped".to_string()))
        .and_then(|reply| reply);
    session.rpc.lock().unwrap().remove(&id);
    result
}
/// Return false for raw/external sessions so callers retain the native socket
/// path. Hosted approval stays on the same app-server and is acknowledged
/// before the held Stop hook is released.
pub async fn queue_codex_implementation(
    app: &AppHandle,
    sid: &str,
    plan: &str,
    approval_id: &str,
) -> Result<bool, String> {
    let session = {
        let state = app.state::<AgentShellState>();
        let sessions = state.0.lock().unwrap();
        sessions
            .values()
            .find(|session| {
                session.request.backend.as_deref() == Some("codex")
                    && session.sid.lock().unwrap().as_str() == sid
                    && session.alive.load(Ordering::Acquire)
                    && !session.raw.load(Ordering::Acquire)
            })
            .cloned()
    };
    let Some(session) = session else {
        return Ok(false);
    };
    if approval_id.is_empty() {
        return Err("The plan is no longer waiting for approval".into());
    }
    let thread = native_rpc(
        &session,
        "thread/read",
        json!({"threadId":sid,"includeTurns":false}),
    )
    .await?;
    let settings = crate::codex_app_server::implementation_settings(sid, &thread)?;
    let mut cursor = Value::Null;
    let mut seen = std::collections::HashSet::new();
    loop {
        let queue = native_rpc(
            &session,
            "thread/queue/list",
            json!({"threadId":sid,"cursor":cursor}),
        )
        .await?;
        let items = queue["data"]
            .as_array()
            .ok_or("Codex returned an invalid queue")?;
        if items
            .iter()
            .any(|item| item["clientUserMessageId"] == approval_id)
        {
            return Ok(true);
        }
        cursor = queue["nextCursor"].clone();
        if cursor.is_null() {
            break;
        }
        if !seen.insert(cursor.to_string()) {
            return Err("Codex repeated a queue cursor".into());
        }
    }
    native_rpc(&session, "thread/settings/update", settings).await?;
    let queued=native_rpc(&session,"thread/queue/add",json!({"threadId":sid,"clientUserMessageId":approval_id,"input":[{"type":"text","text":crate::codex_app_server::implementation_prompt(plan)}]})).await?;
    if queued
        .pointer("/queuedSubmission/id")
        .and_then(Value::as_str)
        .is_none()
    {
        return Err("Codex did not acknowledge the implementation turn".into());
    }
    session
        .writer
        .send(control("set_permission_mode", json!({"mode":"default"})))
        .await
        .map_err(|_| "Hosted driver stopped".to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn agent_shell_list(state: tauri::State<'_, AgentShellState>) -> Vec<Info> {
    state
        .0
        .lock()
        .unwrap()
        .values()
        .map(|session| session.info())
        .collect()
}
#[tauri::command]
pub fn agent_shell_attach(
    state: tauri::State<'_, AgentShellState>,
    id: String,
    attachment_id: String,
    on_output: Channel<Batch>,
) -> Result<Info, String> {
    let session = state.get(&id)?;
    // Snapshot first: event() takes the output lock, never nest it under permissions.
    let pending: Vec<(String, Value)> = session
        .permissions
        .lock()
        .unwrap()
        .iter()
        .map(|(id, request)| (id.clone(), request.clone()))
        .collect();
    for (request_id, request) in &pending {
        session.event(ShellEvent::new("permission",json!({"requestId":request_id,"name":request["tool_name"],"input":request["input"],"suggestions":request["permission_suggestions"]})));
    }
    {
        let mut output = session.output.lock().unwrap();
        let first = output
            .events
            .front()
            .map(|event| event.seq.saturating_sub(1))
            .unwrap_or(output.seq);
        output.subscriber = Some(Subscriber {
            token: attachment_id,
            channel: on_output,
            sent: first,
            ack: first,
        });
    }
    session.flush();
    Ok(session.info())
}
#[tauri::command]
pub fn agent_shell_detach(
    state: tauri::State<'_, AgentShellState>,
    id: String,
    attachment_id: String,
) {
    if let Ok(session) = state.get(&id) {
        let mut output = session.output.lock().unwrap();
        if output
            .subscriber
            .as_ref()
            .is_some_and(|subscriber| subscriber.token == attachment_id)
        {
            output.subscriber = None;
        }
    }
}
#[tauri::command]
pub fn agent_shell_ack(
    state: tauri::State<'_, AgentShellState>,
    id: String,
    attachment_id: String,
    seq: u64,
) {
    if let Ok(session) = state.get(&id) {
        let mut output = session.output.lock().unwrap();
        if let Some(subscriber) = output
            .subscriber
            .as_mut()
            .filter(|subscriber| subscriber.token == attachment_id)
        {
            subscriber.ack = subscriber.ack.max(seq.min(subscriber.sent));
        }
        drop(output);
        session.flush();
    }
}
#[tauri::command]
pub async fn agent_shell_send(
    state: tauri::State<'_, AgentShellState>,
    app: AppHandle,
    id: String,
    text: String,
    memory: Option<bool>,
    chips: Option<Vec<crate::shell_context::Request>>,
) -> Result<(), String> {
    if text.trim().is_empty() || text.len() > 1024 * 1024 {
        return Err("Enter a message under 1 MB".into());
    }
    if ["/raw", "/review", "/restore"].contains(&text.trim()) {
        return Err("This command is handled by the shell view".into());
    }
    let session = state.get(&id)?;
    if !session.alive.load(Ordering::Acquire) || session.raw.load(Ordering::Acquire) {
        return Err("This session is not hosted; resume it before sending".into());
    }
    let mut reservation = BusyReservation::acquire(session.clone())?;
    let context_sid = session.sid.lock().unwrap().clone();
    let mut items = crate::shell_context::resolve(
        &app,
        &session.cwd,
        Some(&context_sid),
        &text,
        chips.unwrap_or_default(),
    )
    .await?;
    let db = app.state::<SessionStore>().database();
    let surface = app.state::<crate::ActiveSurface>().get();
    let since = *session.last_journal.lock().unwrap();
    let journal = db.recent_journal_since(since, 30).unwrap_or_default();
    let journal_cursor = journal.last().map(|row| row.id);
    if journal_cursor.is_some() {
        items.push(json!({"kind":"surface","label":crate::companion::describe_surface(&surface),"origin":"Redline journal","body":crate::companion::render_journal_delta(&journal,12000)}));
    }
    if memory.unwrap_or(false) {
        let memory_db = db.clone();
        let query = text.clone();
        let body = tokio::task::spawn_blocking(move || {
            let evidence = crate::context::build_answer_pack(
                &memory_db,
                Some(&query),
                None,
                crate::context::INLINE_PACK_LIMIT,
            );
            crate::context::render_answer_pack_block(&evidence, None, 16000)
        })
        .await
        .map_err(|error| error.to_string())?;
        items.push(json!({"kind":"memory","label":"Memory answer pack","origin":"Redline memory","body":body}));
    }
    if !session.alive.load(Ordering::Acquire) || session.raw.load(Ordering::Acquire) {
        return Err(
            "The session changed while context was loading; retry in its active view".into(),
        );
    }
    let sid = session.sid.lock().unwrap().clone();
    queue_context(&sid, &items);
    session.event(ShellEvent::new("user", json!({"text":text})));
    if !items.is_empty() {
        session.event(ShellEvent::new("context", json!({"items":items})));
    }
    session.busy.store(true, Ordering::Release);
    if session.writer.send(user_frame(&text)).await.is_err() {
        session.busy.store(false, Ordering::Release);
        CONTEXT
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .remove(&sid);
        return Err("Hosted driver stopped".into());
    }
    if let Some(cursor) = journal_cursor {
        let mut last = session.last_journal.lock().unwrap();
        *last = (*last).max(cursor);
    }
    reservation.committed = true;
    Ok(())
}
#[tauri::command]
pub async fn agent_shell_permission_respond(
    state: tauri::State<'_, AgentShellState>,
    id: String,
    request_id: String,
    decision: String,
    note: Option<String>,
    answers: Option<Value>,
) -> Result<(), String> {
    let session = state.get(&id)?;
    if !["allow", "always", "deny"].contains(&decision.as_str()) {
        return Err("Unknown permission decision".into());
    }
    let request = session
        .permissions
        .lock()
        .unwrap()
        .get(&request_id)
        .cloned()
        .ok_or("This permission is no longer pending")?;
    if let Some(codex_id) = request.get("codexId") {
        let result = if request["method"] == "item/tool/requestUserInput" {
            let mut mapped = serde_json::Map::new();
            if let Some(questions) = request["input"]["questions"].as_array() {
                for question in questions {
                    let id = question["id"].as_str().unwrap_or("");
                    let title = question["question"].as_str().unwrap_or("");
                    let answer = answers
                        .as_ref()
                        .and_then(|answers| answers.get(title))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    mapped.insert(
                        id.into(),
                        json!({"answers":[if decision=="deny" {"Declined"} else {answer}]}),
                    );
                }
            }
            json!({"answers":mapped})
        } else {
            json!({"decision":if decision=="deny" {"decline"} else if decision=="always" {"acceptForSession"} else {"accept"}})
        };
        session
            .writer
            .send(json!({"id":codex_id,"result":result}))
            .await
            .map_err(|_| "Hosted driver stopped".to_string())?;
        session.permissions.lock().unwrap().remove(&request_id);
        session.event(ShellEvent::new(
            "permission-resolved",
            json!({"requestId":request_id,"decision":decision}),
        ));
        return Ok(());
    }
    let response = if decision == "deny" {
        json!({"behavior":"deny","message":note.unwrap_or_else(||"The user declined this action".into())})
    } else {
        let mut input = request["input"].clone();
        if request["tool_name"] == "AskUserQuestion" {
            if let Some(answers) = answers {
                input["answers"] = answers;
            }
        }
        let mut response = json!({"behavior":"allow","updatedInput":input});
        if decision == "always" {
            let rules = request["permission_suggestions"].clone();
            if !rules.is_array() {
                return Err("The CLI did not suggest a persistent rule".into());
            }
            response["updatedPermissions"] = rules;
        }
        response
    };
    session.writer.send(json!({"type":"control_response","response":{"subtype":"success","request_id":request_id,"response":response}})).await.map_err(|_|"Hosted driver stopped".to_string())?;
    session.permissions.lock().unwrap().remove(&request_id);
    session.event(ShellEvent::new(
        "permission-resolved",
        json!({"requestId":request_id,"decision":decision}),
    ));
    Ok(())
}
#[tauri::command]
pub async fn agent_shell_control(
    state: tauri::State<'_, AgentShellState>,
    id: String,
    subtype: String,
    value: Option<String>,
) -> Result<(), String> {
    let session = state.get(&id)?;
    if subtype == "interrupt" {
        clear_context(&session);
    }
    let fields = match subtype.as_str() {
        "interrupt" => json!({}),
        "set_permission_mode" => {
            let mode = value.ok_or("Choose a permission mode")?;
            if !["plan", "default", "manual", "acceptEdits", "auto"].contains(&mode.as_str()) {
                return Err("Unsupported permission mode".into());
            }
            json!({"mode":mode})
        }
        "set_model" => json!({"model":value}),
        _ => return Err("Unsupported hosted control".into()),
    };
    session
        .writer
        .send(control(&subtype, fields))
        .await
        .map_err(|_| "Hosted driver stopped".into())
}
#[tauri::command]
pub async fn agent_shell_interrupt(
    state: tauri::State<'_, AgentShellState>,
    id: String,
) -> Result<(), String> {
    agent_shell_control(state, id, "interrupt".into(), None).await
}
#[tauri::command]
pub fn agent_shell_stop(
    state: tauri::State<'_, AgentShellState>,
    id: String,
) -> Result<(), String> {
    let session = state.get(&id)?;
    kill(&session);
    Ok(())
}
#[tauri::command]
pub fn agent_shell_kill_all(state: tauri::State<'_, AgentShellState>) {
    state.kill_all();
}
#[tauri::command]
pub async fn agent_shell_handoff(
    state: tauri::State<'_, AgentShellState>,
    store: tauri::State<'_, SessionStore>,
    id: String,
) -> Result<Info, String> {
    let session = state.get(&id)?;
    let reservation = BusyReservation::acquire(session.clone())?;
    let info = session.info();
    if !session.permissions.lock().unwrap().is_empty() {
        return Err("Wait until the agent is idle before changing views".into());
    }
    if store
        .list()
        .iter()
        .any(|plan| plan.session_id == info.session_id && plan.attach_state == AttachState::Held)
    {
        return Err("Finish the plan review before opening raw view".into());
    }
    // Keep registry ownership even after the stopped driver's cleanup clears busy.
    session.raw.store(true, Ordering::Release);
    kill(&session);
    for _ in 0..100 {
        if !hosted_pids().values().any(|tab| tab == &id) {
            session.raw.store(true, Ordering::Release);
            drop(reservation);
            return Ok(session.info());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Err("The hosted driver is still stopping".into())
}
fn history_events(value: &Value) -> Vec<ShellEvent> {
    let mut events = Vec::new();
    if value["type"] == "user" {
        if let Some(text) = value.pointer("/message/content").and_then(Value::as_str) {
            events.push(ShellEvent::new("user", json!({"text":text})));
        }
    }
    if let Some(blocks) = value.pointer("/message/content").and_then(Value::as_array) {
        for block in blocks {
            if block["type"] == "text" {
                events.push(ShellEvent::new(
                    if value["type"] == "user" {
                        "user"
                    } else {
                        "text"
                    },
                    json!({"text":block["text"]}),
                ));
            }
        }
    }
    events.extend(normalize(value));
    events
}

#[tauri::command]
pub async fn agent_shell_history(
    session_id: String,
    backend: Option<String>,
) -> Result<Vec<ShellEvent>, String> {
    if !crate::claude_proc::is_plain_session_id(&session_id) {
        return Err("Invalid session identifier".into());
    }
    if backend.as_deref() == Some("codex") {
        let bin = tokio::task::spawn_blocking(crate::codex_app_server::resolve_codex_bin)
            .await
            .map_err(|e| e.to_string())?;
        let reply = crate::codex_app_server::inspect_request(
            &bin,
            "thread/read",
            json!({"threadId":session_id,"includeTurns":true}),
        )
        .await?;
        let mut events = Vec::new();
        if let Some(turns) = reply["thread"]["turns"].as_array() {
            for turn in turns {
                if let Some(items) = turn["items"].as_array() {
                    for item in items {
                        match item["type"].as_str().unwrap_or("") {
                            "userMessage" => {
                                let text = item["content"]
                                    .as_array()
                                    .map(|content| {
                                        content
                                            .iter()
                                            .filter_map(|part| part["text"].as_str())
                                            .filter(|text| !text.starts_with("<redline-context>"))
                                            .collect::<Vec<_>>()
                                            .join("\n")
                                    })
                                    .unwrap_or_default();
                                events.push(ShellEvent::new("user", json!({"text":text})));
                            }
                            "agentMessage" => {
                                events.push(ShellEvent::new("text", json!({"text":item["text"]})))
                            }
                            _ => {
                                events.extend(normalize_codex(
                                    &json!({"method":"item/started","params":{"item":item}}),
                                ));
                                events.extend(normalize_codex(
                                    &json!({"method":"item/completed","params":{"item":item}}),
                                ));
                            }
                        }
                    }
                }
            }
        }
        for (seq, event) in events.iter_mut().enumerate() {
            event.seq = seq as u64 + 1;
        }
        return Ok(events);
    }
    tokio::task::spawn_blocking(move || {
        use std::io::{BufRead, Seek, SeekFrom};
        let path = crate::claude_proc::find_transcript(&session_id)
            .ok_or("No saved transcript was found")?;
        let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let length = file.metadata().map_err(|e| e.to_string())?.len();
        let offset = length.saturating_sub(REPLAY_BYTES as u64);
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| e.to_string())?;
        let mut lines = std::io::BufReader::new(file).lines();
        if offset > 0 {
            lines.next();
        }
        let mut events = Vec::new();
        for line in lines.map_while(Result::ok) {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                events.extend(history_events(&value));
            }
        }
        for (seq, event) in events.iter_mut().enumerate() {
            event.seq = seq as u64 + 1;
        }
        Ok(events)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn agent_shell_resume_hosted(
    state: tauri::State<'_, AgentShellState>,
    app: AppHandle,
    id: String,
    request: Launch,
) -> Result<Info, String> {
    let mut replacing = None;
    if let Ok(session) = state.get(&id) {
        if session.alive.load(Ordering::Acquire) && !session.raw.load(Ordering::Acquire) {
            return Err("The hosted driver is already running".into());
        }
        let sid = session.sid.lock().unwrap().clone();
        if request.session_id.as_deref() != Some(sid.as_str())
            || request.backend.as_deref().unwrap_or("claude-code")
                != session.request.backend.as_deref().unwrap_or("claude-code")
        {
            return Err("The requested conversation does not match this tab".into());
        }
        let requested_cwd = request.cwd.as_deref().unwrap_or(&session.cwd);
        let requested_cwd =
            std::fs::canonicalize(requested_cwd).map_err(|error| error.to_string())?;
        if requested_cwd != std::path::Path::new(&session.cwd) {
            let relocated = if request.backend.as_deref() == Some("codex") {
                app.state::<SessionStore>().get(&sid).is_some_and(|plan| {
                    std::fs::canonicalize(plan.project_path).ok().as_ref() == Some(&requested_cwd)
                })
            } else {
                false
            };
            if !relocated {
                return Err("Resume this conversation in its original folder; use an additional project folder for new work".into());
            }
        }
        if app
            .state::<SessionStore>()
            .list()
            .iter()
            .any(|plan| plan.session_id == sid && plan.attach_state == AttachState::Held)
        {
            return Err("Finish the held review before switching views".into());
        }
        crate::pty::stop_for_handoff(app.state::<crate::pty::PtyState>(), id.clone()).await?;
        // Keep raw ownership until start atomically replaces this exact registry entry.
        replacing = Some(session);
    } else {
        crate::pty::stop_for_handoff(app.state::<crate::pty::PtyState>(), id.clone()).await?;
    }
    start(state.inner().clone(), app, id, request, replacing).await
}
#[tauri::command]
pub fn terminal_default_view_get(store: tauri::State<'_, SessionStore>) -> String {
    store
        .database()
        .get_setting("redline.terminal.defaultView")
        .filter(|value| value == "shell" || value == "raw")
        .unwrap_or_else(|| "shell".into())
}
#[tauri::command]
pub fn terminal_default_view_set(
    store: tauri::State<'_, SessionStore>,
    view: String,
) -> Result<(), String> {
    if view != "shell" && view != "raw" {
        return Err("Choose shell or raw".into());
    }
    store
        .database()
        .set_setting("redline.terminal.defaultView", &view)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session() -> Arc<Session> {
        let request: Launch =
            serde_json::from_value(json!({"cwd":"/tmp","prompt":"","permissionMode":"plan"}))
                .unwrap();
        let (writer, _) = tokio::sync::mpsc::channel(4);
        Arc::new(Session {
            driver_id: "driver".into(),
            id: "tab".into(),
            sid: Mutex::new("test-session".into()),
            cwd: "/tmp".into(),
            request,
            output: Mutex::new(Output::default()),
            alive: AtomicBool::new(true),
            busy: AtomicBool::new(false),
            raw: AtomicBool::new(false),
            writer,
            stop: tokio::sync::Notify::new(),
            permissions: Mutex::new(HashMap::new()),
            rpc: Mutex::new(HashMap::new()),
            last_journal: Mutex::new(0),
            pid: Mutex::new(None),
        })
    }
    #[test]
    fn admission_retains_startup_and_handoff_ownership() {
        let session = session();
        let sessions = HashMap::from([(session.id.clone(), session.clone())]);
        assert!(validate_admission(&sessions, "other-tab", "test-session", None).is_err());
        assert!(validate_admission(&sessions, "tab", "other-session", None).is_err());
        session.alive.store(false, Ordering::Release);
        session.busy.store(true, Ordering::Release);
        assert!(validate_admission(&sessions, "tab", "other-session", None).is_err());
        session.busy.store(false, Ordering::Release);
        session.raw.store(true, Ordering::Release);
        assert!(validate_admission(&sessions, "tab", "test-session", None).is_err());
        *session.pid.lock().unwrap() = Some(1234);
        assert!(validate_admission(&sessions, "tab", "test-session", Some(&session)).is_err());
        *session.pid.lock().unwrap() = None;
        assert!(validate_admission(&sessions, "tab", "test-session", Some(&session)).is_ok());
        let replacement = super::tests::session();
        let sessions = HashMap::from([(replacement.id.clone(), replacement)]);
        assert!(validate_admission(&sessions, "tab", "test-session", Some(&session)).is_err());
    }
    #[test]
    fn send_reservation_rolls_back_failures_and_keeps_accepted_turns_busy() {
        let session = session();
        let reservation = BusyReservation::acquire(session.clone()).unwrap();
        assert!(BusyReservation::acquire(session.clone()).is_err());
        drop(reservation);
        assert!(!session.busy.load(Ordering::Acquire));
        let mut accepted = BusyReservation::acquire(session.clone()).unwrap();
        accepted.committed = true;
        drop(accepted);
        assert!(session.busy.load(Ordering::Acquire));
    }
    #[tokio::test]
    async fn stop_before_driver_loop_keeps_a_notification_permit() {
        let session = session();
        kill(&session);
        assert!(!session.alive.load(Ordering::Acquire));
        tokio::time::timeout(Duration::from_millis(100), session.stop.notified())
            .await
            .expect("stop must wake a driver whose loop has not started yet");
    }
    #[cfg(unix)]
    #[test]
    fn final_exit_kills_owned_process_groups_even_when_term_is_ignored() {
        use std::os::unix::process::CommandExt;
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "trap '' TERM; while :; do sleep 1; done"])
            .process_group(0)
            .spawn()
            .unwrap();
        let session = session();
        *session.pid.lock().unwrap() = Some(child.id());
        let state = AgentShellState::default();
        state.0.lock().unwrap().insert(session.id.clone(), session);
        state.kill_all();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while child.try_wait().unwrap().is_none() {
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("owned process survived final exit");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    #[test]
    fn history_preserves_plain_string_user_turns_and_whitespace() {
        let original = "  quoted <system-reminder>mine</system-reminder>\n";
        let events = history_events(&json!({"type":"user","message":{"content":original}}));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].kind, "user");
        assert_eq!(events[0].data["text"], original);
    }
    #[test]
    fn hosted_prompt_preserves_bytes_and_launch_flags() {
        let request:Launch=serde_json::from_value(json!({"cwd":"/tmp","prompt":"  original\n<system-reminder>quoted</system-reminder>\n","permissionMode":"plan","model":"sonnet","effort":"high","sessionId":"same","addDirs":["/tmp/changed project"]})).unwrap();
        assert_eq!(
            user_frame(&request.prompt)["message"]["content"][0]["text"],
            request.prompt
        );
        assert_eq!(
            crate::ledger::body_hash(
                user_frame(&request.prompt)["message"]["content"][0]["text"]
                    .as_str()
                    .unwrap()
            ),
            crate::ledger::body_hash(&request.prompt)
        );
        let args = command_args(&request, "same").unwrap();
        for pair in [
            ["--model", "sonnet"],
            ["--effort", "high"],
            ["--resume", "same"],
            ["--permission-prompt-tool", "stdio"],
            ["--add-dir", "/tmp/changed project"],
        ] {
            assert!(args
                .windows(2)
                .any(|window| window[0] == pair[0] && window[1] == pair[1]));
        }
    }
    #[test]
    fn output_stays_bounded_and_ack_credit_never_exceeds_window() {
        let session = session();
        for _ in 0..5000 {
            session.event(ShellEvent::new("delta", json!({"text":"a".repeat(800)})));
        }
        {
            let mut output = session.output.lock().unwrap();
            assert!(output.bytes <= REPLAY_BYTES);
            assert!(output.events.len() <= 4096);
            let first = output.events.front().unwrap().seq - 1;
            output.subscriber = Some(Subscriber {
                token: "a".into(),
                channel: Channel::new(|_| Ok(())),
                sent: first,
                ack: first,
            });
        }
        session.flush();
        {
            let output = session.output.lock().unwrap();
            let sub = output.subscriber.as_ref().unwrap();
            assert_eq!(sub.sent - sub.ack, IN_FLIGHT);
        }
        {
            let mut output = session.output.lock().unwrap();
            output.subscriber.as_mut().unwrap().ack += 128;
        }
        session.flush();
        {
            let output = session.output.lock().unwrap();
            let sub = output.subscriber.as_ref().unwrap();
            assert_eq!(sub.sent - sub.ack, IN_FLIGHT);
        }
    }
    #[test]
    fn context_fifo_keeps_empty_turns_and_is_consumed_once() {
        let sid = uuid::Uuid::new_v4().to_string();
        queue_context(&sid, &[]);
        queue_context(
            &sid,
            &[json!({"label":"fixture","origin":"test","body":"ORCHID"})],
        );
        assert!(take_context(&sid).is_none());
        assert!(
            take_context(&sid).unwrap()["hookSpecificOutput"]["additionalContext"]
                .as_str()
                .unwrap()
                .contains("ORCHID")
        );
        assert!(take_context(&sid).is_none());
    }
    #[test]
    fn plan_meter_and_hosted_meter_have_one_owner() {
        assert!(!shell_books_meter(true, "auto"));
        assert!(!shell_books_meter(true, "plan"));
        assert!(!shell_books_meter(false, "plan"));
        assert!(shell_books_meter(false, "auto"));
        assert!(shell_books_meter(false, "default"));
    }
}
