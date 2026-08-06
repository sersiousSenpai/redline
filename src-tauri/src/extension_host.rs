//! In-process WASM extension host (Elevation B3).
//!
//! Runs `kind: "wasm"` extensions (manifest v2, `extension.rs`) inside the
//! app with wasmi — a pure-Rust interpreter chosen over a JIT deliberately
//! (+~1.5 MB vs +8-12 MB; v1 extensions are glue, interpreter overhead is
//! milliseconds). The engine sits behind the one-impl [`Runtime`] seam and
//! the ABI is core-wasm only, so a feature-gated JIT stays purely additive.
//!
//! **Capability inheritance (the sacred part):** a guest's `host_call`
//! constructs a real `axum::http::Request` bearing the extension's per-boot
//! token and drives it through **the same Router** the daemon serves, via
//! `tower::ServiceExt::oneshot`. Consequences inherited for free: the pure
//! `authorize()` decision, fail-closed unknown routes, friction on scope
//! misses, and the api-doc golden + route-drift tests govern the WASM
//! surface identically. There is no second dispatch path to audit. The
//! token never touches disk or guest memory.
//!
//! **Isolation:** per-delivery fuel budget, a 64 MB linear-memory limiter,
//! a 10 MB module cap, and `catch_unwind` around every delivery. A trap,
//! fuel exhaustion, non-zero return, or glue panic logs, records friction,
//! and rebuilds a fresh instance; three strikes in one boot disables the
//! extension until relaunch (surfaced in the Extensions UI). An extension
//! can never take the app down.
//!
//! **Non-goals (v1, restated from the program):** no theme/font/skill
//! contribution (a7be07f stands), no commands, no keybindings, no arbitrary
//! DOM. The one sanctioned UI slot is a host-sanitized markdown panel
//! written via the real `POST /v1/extensions/:name/panel` route.

use std::collections::{HashSet, VecDeque};
use std::net::SocketAddr;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ConnectInfo;
use axum::http::{header, Method, Request};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tower::ServiceExt;

use redline_extension_abi::abi;
use redline_extension_abi::host::{HostCallRequest, HostCallResponse};
use redline_extension_abi::API_VERSION;

use crate::extension::BootedExtension;

/// Hard ceilings. All deliberate constants of the v1 contract; changing one
/// is a reviewed ABI decision, not a tuning knob.
const MODULE_CAP_BYTES: u64 = 10 * 1024 * 1024;
const MEMORY_CAP_BYTES: usize = 64 * 1024 * 1024;
/// Interpreter fuel per `rl_init`/`rl_on_event` call — roughly "hundreds of
/// milliseconds of pure compute", far beyond any glue workload.
const FUEL_PER_DELIVERY: u64 = 100_000_000;
const QUEUE_CAP: usize = 256;
const STRIKES_TO_DISABLE: u32 = 3;
/// Ceiling on one `host_call` round-trip so a held route (`/v1/plan` blocks
/// for a review verdict) cannot wedge a dispatcher thread forever.
const HOST_CALL_TIMEOUT: Duration = Duration::from_secs(120);
/// Response bodies larger than this come back as 502 (a snapshot of a huge
/// page is the realistic worst case; 8 MB is far above it).
const HOST_CALL_RESP_CAP: usize = 8 * 1024 * 1024;
/// Panel markdown cap after sanitization.
const PANEL_CAP_BYTES: usize = 32 * 1024;

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Router cell — the single dispatch path.

static ROUTER: OnceLock<axum::Router> = OnceLock::new();

/// Install the daemon's router for `host_call` dispatch. Called once by
/// `run_server` with a clone of the exact router it serves; a second call
/// (never expected) is ignored.
pub fn install_router(router: axum::Router) {
    if ROUTER.set(router).is_err() {
        tracing::warn!("extension host router already installed — ignoring");
    }
}

// ---------------------------------------------------------------------------
// Registry.

#[derive(Debug, Clone, PartialEq)]
enum Status {
    /// `kind: "external"` — the host lists it but does not run it.
    External,
    Starting,
    Running,
    /// Could not load/compile/instantiate — terminal for this boot.
    Failed(String),
    /// User-disabled, or three strikes. Until relaunch (or re-enable).
    Disabled(String),
}

impl Status {
    fn key(&self) -> &'static str {
        match self {
            Status::External => "external",
            Status::Starting => "starting",
            Status::Running => "running",
            Status::Failed(_) => "failed",
            Status::Disabled(_) => "disabled",
        }
    }

    fn detail(&self) -> Option<String> {
        match self {
            Status::Failed(d) | Status::Disabled(d) => Some(d.clone()),
            _ => None,
        }
    }
}

struct ExtensionState {
    name: String,
    version: Option<String>,
    kind: String,
    scopes: Vec<String>,
    events: Vec<String>,
    dir: PathBuf,
    module: Option<PathBuf>,
    /// The per-boot bearer token `host_call` attaches. For wasm extensions
    /// this is the only place it exists.
    token: String,
    status: Mutex<Status>,
    strikes: AtomicU32,
    /// Why the most recent strike happened — surfaced in the UI and asserted
    /// by tests (e.g. "rl_on_event returned 401").
    last_strike: Mutex<Option<String>>,
    panel: Mutex<Option<String>>,
    queue: EventQueue,
}

impl ExtensionState {
    fn subscribed(&self, event: &str) -> bool {
        self.events.iter().any(|e| e == event)
    }

    fn set_status(&self, status: Status) {
        *self.status.lock().expect("status lock") = status;
    }

    fn status(&self) -> Status {
        self.status.lock().expect("status lock").clone()
    }

    /// Record one strike; the third disables the extension for this boot.
    /// Returns true when the extension was just disabled.
    fn strike(&self, why: &str) -> bool {
        let strikes = self.strikes.fetch_add(1, Ordering::SeqCst) + 1;
        *self.last_strike.lock().expect("strike lock") = Some(why.to_string());
        tracing::warn!(
            "extension {}: strike {strikes}/{STRIKES_TO_DISABLE}: {why}",
            self.name
        );
        crate::db::note_friction(
            "extension_strike",
            Some("extensions"),
            None,
            Some(&format!("{}: {why}", self.name)),
        );
        if strikes >= STRIKES_TO_DISABLE {
            self.set_status(Status::Disabled(format!(
                "disabled after {STRIKES_TO_DISABLE} strikes this boot (last: {why})"
            )));
            self.queue.close();
            crate::db::note_friction(
                "extension_disabled",
                Some("extensions"),
                None,
                Some(&self.name),
            );
            notify_changed();
            return true;
        }
        notify_changed();
        false
    }
}

struct Registry {
    app: RwLock<Option<AppHandle>>,
    exts: RwLock<Vec<Arc<ExtensionState>>>,
}

fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| Registry {
        app: RwLock::new(None),
        exts: RwLock::new(Vec::new()),
    })
}

/// Tell the Extensions UI something changed (status, strikes, panel).
fn notify_changed() {
    if let Some(app) = registry().app.read().expect("app lock").as_ref() {
        let _ = app.emit("extensions-changed", ());
    }
}

/// One row of `GET /v1/extensions` / the `extensions_list` IPC.
#[derive(Debug, Clone, Serialize)]
pub struct ExtensionInfo {
    pub name: String,
    pub version: Option<String>,
    pub kind: String,
    pub scopes: Vec<String>,
    pub events: Vec<String>,
    pub status: String,
    pub detail: Option<String>,
    pub strikes: u32,
    pub panel: Option<String>,
    pub dir: String,
}

pub fn snapshot() -> Vec<ExtensionInfo> {
    registry()
        .exts
        .read()
        .expect("exts lock")
        .iter()
        .map(|e| {
            let status = e.status();
            ExtensionInfo {
                name: e.name.clone(),
                version: e.version.clone(),
                kind: e.kind.clone(),
                scopes: e.scopes.clone(),
                events: e.events.clone(),
                status: status.key().to_string(),
                detail: status.detail().or_else(|| {
                    e.last_strike.lock().expect("strike lock").clone()
                }),
                strikes: e.strikes.load(Ordering::SeqCst),
                panel: e.panel.lock().expect("panel lock").clone(),
                dir: e.dir.display().to_string(),
            }
        })
        .collect()
}

/// Build one registry entry from a booted extension. The status a fresh
/// registration starts in is the same whether it arrives at boot or via
/// B4's marketplace hot-install.
fn new_state(b: BootedExtension, user_disabled: bool) -> Arc<ExtensionState> {
    let is_wasm = b.ext.manifest.is_wasm();
    let status = if !is_wasm {
        Status::External
    } else if user_disabled {
        Status::Disabled("disabled by user (relaunch after enabling)".to_string())
    } else {
        Status::Starting
    };
    Arc::new(ExtensionState {
        name: b.ext.manifest.name.clone(),
        version: b.ext.manifest.version.clone(),
        kind: b.ext.manifest.kind().to_string(),
        scopes: b.ext.manifest.scopes.clone(),
        events: b.ext.manifest.events.clone(),
        dir: b.ext.dir.clone(),
        module: b.ext.module_path(),
        token: b.token,
        status: Mutex::new(status),
        strikes: AtomicU32::new(0),
        last_strike: Mutex::new(None),
        panel: Mutex::new(None),
        queue: EventQueue::new(),
    })
}

fn spawn_dispatcher(state: Arc<ExtensionState>) {
    std::thread::Builder::new()
        .name(format!("rl-ext-{}", state.name))
        .spawn(move || dispatcher_loop(state))
        .ok();
}

/// Start the host: register every booted extension (external ones list-only)
/// and spawn one dispatcher thread per enabled wasm extension. Called once
/// at boot, after `install_boot_tokens`; extensions in `disabled` (the
/// persisted user choice) are registered but never instantiated.
pub fn start(app: AppHandle, booted: Vec<BootedExtension>, disabled: &HashSet<String>) {
    let reg = registry();
    *reg.app.write().expect("app lock") = Some(app);
    let mut workers = Vec::new();
    {
        let mut exts = reg.exts.write().expect("exts lock");
        for b in booted {
            let user_disabled = disabled.contains(&b.ext.manifest.name);
            let state = new_state(b, user_disabled);
            if state.kind == crate::extension::KIND_WASM
                && matches!(state.status(), Status::Starting)
            {
                workers.push(state.clone());
            }
            exts.push(state);
        }
    }
    for state in workers {
        spawn_dispatcher(state);
    }
}

/// Hot-register one just-installed extension (B4 marketplace install/update
/// — no relaunch): the state enters the registry and, for an enabled wasm
/// extension, gets its dispatcher thread immediately. Errors on a duplicate
/// name — an update removes (and revokes) the old registration first.
pub fn load_one(booted: BootedExtension, user_disabled: bool) -> Result<(), String> {
    let state = new_state(booted, user_disabled);
    {
        let mut exts = registry().exts.write().expect("exts lock");
        if exts.iter().any(|e| e.name == state.name) {
            return Err(format!(
                "extension {:?} is already registered — remove it before reinstalling",
                state.name
            ));
        }
        exts.push(state.clone());
    }
    if state.kind == crate::extension::KIND_WASM && matches!(state.status(), Status::Starting) {
        spawn_dispatcher(state);
    }
    notify_changed();
    Ok(())
}

/// Publish one event to every running wasm extension subscribed to it.
/// Enqueue-only — never blocks the caller (the emit sites live on hot
/// paths); serialization happens once and only if someone subscribes.
pub fn publish<T: Serialize>(name: &str, payload: &T) {
    let subs: Vec<Arc<ExtensionState>> = registry()
        .exts
        .read()
        .expect("exts lock")
        .iter()
        .filter(|e| e.subscribed(name) && matches!(e.status(), Status::Starting | Status::Running))
        .cloned()
        .collect();
    if subs.is_empty() {
        return;
    }
    let json = match serde_json::to_string(payload) {
        Ok(j) => j,
        Err(e) => {
            tracing::warn!("extension event {name}: payload serialize failed: {e}");
            return;
        }
    };
    for ext in subs {
        if ext.queue.push(name.to_string(), json.clone()) {
            crate::db::note_friction(
                "extension_queue_overflow",
                Some("extensions"),
                None,
                Some(&ext.name),
            );
        }
    }
}

/// User toggle (trusted UI IPC). Disable takes effect immediately (the
/// dispatcher stops); enable takes effect at next launch — the UI says so.
/// Persistence of the choice lives with the caller (db `extensions.disabled`).
pub fn set_enabled(name: &str, enabled: bool) -> Result<(), String> {
    let exts = registry().exts.read().expect("exts lock");
    let ext = exts
        .iter()
        .find(|e| e.name == name)
        .ok_or_else(|| format!("unknown extension {name:?}"))?;
    if enabled {
        // Instantiation happens at boot; flipping the persisted flag is the
        // caller's job and the status text points at relaunch.
        if matches!(ext.status(), Status::Disabled(_)) {
            ext.set_status(Status::Disabled(
                "enabled — takes effect at next launch".to_string(),
            ));
        }
    } else if ext.kind == crate::extension::KIND_WASM {
        ext.set_status(Status::Disabled("disabled by user".to_string()));
        ext.queue.close();
    }
    notify_changed();
    Ok(())
}

/// Remove an extension from the registry (trusted UI IPC; the caller
/// deletes the directory). Its grant dies with the boot that minted it.
pub fn remove(name: &str) -> Result<PathBuf, String> {
    let mut exts = registry().exts.write().expect("exts lock");
    let idx = exts
        .iter()
        .position(|e| e.name == name)
        .ok_or_else(|| format!("unknown extension {name:?}"))?;
    let ext = exts.remove(idx);
    ext.queue.close();
    notify_changed();
    Ok(ext.dir.clone())
}

/// Replace an extension's markdown panel (the sanctioned UI slot). Called
/// by the panel route after its grant-name check.
pub fn set_panel(name: &str, markdown: &str) -> Result<(), String> {
    let exts = registry().exts.read().expect("exts lock");
    let ext = exts
        .iter()
        .find(|e| e.name == name)
        .ok_or_else(|| format!("unknown extension {name:?}"))?;
    *ext.panel.lock().expect("panel lock") = Some(sanitize_panel(markdown));
    drop(exts);
    notify_changed();
    Ok(())
}

/// Host-side sanitization: byte-cap at a char boundary and strip control
/// characters (except newline/tab). Rendering still flows through the app's
/// existing markdown pipeline — this guards size and terminal-control games,
/// not markup (the pipeline owns that).
fn sanitize_panel(markdown: &str) -> String {
    let mut out: String = markdown
        .chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect();
    if out.len() > PANEL_CAP_BYTES {
        let mut cut = PANEL_CAP_BYTES;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push_str("\n\n… (truncated at 32 KB)");
    }
    out
}

// ---------------------------------------------------------------------------
// Event queue: bounded, drop-oldest, condvar-signalled.

struct QueueInner {
    items: VecDeque<(String, String)>,
    closed: bool,
}

struct EventQueue {
    inner: Mutex<QueueInner>,
    cv: Condvar,
}

impl EventQueue {
    fn new() -> Self {
        EventQueue {
            inner: Mutex::new(QueueInner {
                items: VecDeque::new(),
                closed: false,
            }),
            cv: Condvar::new(),
        }
    }

    /// Enqueue; returns true if the oldest event was dropped to make room.
    fn push(&self, name: String, payload: String) -> bool {
        let mut inner = self.inner.lock().expect("queue lock");
        if inner.closed {
            return false;
        }
        let mut dropped = false;
        if inner.items.len() >= QUEUE_CAP {
            inner.items.pop_front();
            dropped = true;
        }
        inner.items.push_back((name, payload));
        self.cv.notify_one();
        dropped
    }

    /// Block until an event arrives; `None` means the queue closed.
    fn pop(&self) -> Option<(String, String)> {
        let mut inner = self.inner.lock().expect("queue lock");
        loop {
            if let Some(item) = inner.items.pop_front() {
                return Some(item);
            }
            if inner.closed {
                return None;
            }
            inner = self.cv.wait(inner).expect("queue wait");
        }
    }

    fn close(&self) {
        self.inner.lock().expect("queue lock").closed = true;
        self.cv.notify_all();
    }
}

// ---------------------------------------------------------------------------
// The wasmi runtime, behind the one-impl seam.

/// Per-store host state the `redline` imports read.
struct StoreData {
    name: String,
    token: String,
    limits: wasmi::StoreLimits,
}

/// The runtime seam: everything wasmi-specific lives behind this struct.
/// If a marketplace extension ever proves compute-bound, a feature-gated
/// `ext-jit` alternative implements the same four operations.
struct Runtime {
    engine: wasmi::Engine,
    module: wasmi::Module,
    linker: wasmi::Linker<StoreData>,
}

/// A live instance (store + instance pair), rebuilt fresh after a strike.
struct LiveInstance {
    store: wasmi::Store<StoreData>,
    instance: wasmi::Instance,
}

/// One delivery's outcome, from the host's point of view.
#[derive(Debug, PartialEq)]
enum Delivery {
    Ok,
    /// The guest returned non-zero / trapped / ran out of fuel / panicked
    /// the glue — the instance must be considered poisoned.
    Strike(String),
}

impl Runtime {
    fn load(name: &str, module_path: &PathBuf) -> Result<Runtime, String> {
        let meta = std::fs::metadata(module_path)
            .map_err(|e| format!("module {}: {e}", module_path.display()))?;
        if meta.len() > MODULE_CAP_BYTES {
            return Err(format!(
                "module is {} bytes — over the {} MB cap",
                meta.len(),
                MODULE_CAP_BYTES / (1024 * 1024)
            ));
        }
        let bytes = std::fs::read(module_path)
            .map_err(|e| format!("module {}: {e}", module_path.display()))?;
        Runtime::from_bytes(name, &bytes)
    }

    fn from_bytes(name: &str, bytes: &[u8]) -> Result<Runtime, String> {
        let mut config = wasmi::Config::default();
        config.consume_fuel(true);
        let engine = wasmi::Engine::new(&config);
        let module = wasmi::Module::new(&engine, bytes)
            .map_err(|e| format!("module compile failed: {e}"))?;
        let mut linker = wasmi::Linker::<StoreData>::new(&engine);
        linker
            .func_wrap(
                abi::HOST_MODULE,
                abi::HOST_CALL,
                move |mut caller: wasmi::Caller<'_, StoreData>, req_ptr: i32, req_len: i32| -> i64 {
                    host_call_entry(&mut caller, req_ptr, req_len)
                },
            )
            .map_err(|e| format!("link {}: {e}", abi::HOST_CALL))?;
        linker
            .func_wrap(
                abi::HOST_MODULE,
                abi::HOST_LOG,
                move |mut caller: wasmi::Caller<'_, StoreData>,
                      level: i32,
                      ptr: i32,
                      len: i32| {
                    let msg = read_guest_str(&mut caller, ptr, len)
                        .unwrap_or_else(|| "<invalid utf-8>".to_string());
                    let name = &caller.data().name;
                    match level {
                        0 => tracing::debug!("extension {name}: {msg}"),
                        2 => tracing::warn!("extension {name}: {msg}"),
                        3 => tracing::error!("extension {name}: {msg}"),
                        _ => tracing::info!("extension {name}: {msg}"),
                    }
                },
            )
            .map_err(|e| format!("link {}: {e}", abi::HOST_LOG))?;
        Ok(Runtime {
            engine,
            module,
            linker,
        })
    }

    /// Fresh store + instance: api-version handshake, then `rl_init`.
    fn instantiate(&self, name: &str, token: &str) -> Result<LiveInstance, String> {
        let limits = wasmi::StoreLimitsBuilder::new()
            .memory_size(MEMORY_CAP_BYTES)
            .memories(1)
            .build();
        let mut store = wasmi::Store::new(
            &self.engine,
            StoreData {
                name: name.to_string(),
                token: token.to_string(),
                limits,
            },
        );
        store.limiter(|data| &mut data.limits);
        store
            .set_fuel(FUEL_PER_DELIVERY)
            .map_err(|e| format!("set_fuel: {e}"))?;
        let instance = self
            .linker
            .instantiate_and_start(&mut store, &self.module)
            .map_err(|e| format!("instantiate: {e}"))?;
        let api: i32 = call_typed0(&mut store, &instance, abi::EXPORT_API_VERSION)
            .map_err(|e| format!("{}: {e}", abi::EXPORT_API_VERSION))?;
        if api != API_VERSION as i32 {
            return Err(format!(
                "module speaks ABI {api}, host speaks {API_VERSION}"
            ));
        }
        let rc: i32 = call_typed0(&mut store, &instance, abi::EXPORT_INIT)
            .map_err(|e| format!("{}: {e}", abi::EXPORT_INIT))?;
        if rc != 0 {
            return Err(format!("{} returned {rc}", abi::EXPORT_INIT));
        }
        Ok(LiveInstance { store, instance })
    }

    /// Deliver one event under a fresh fuel budget.
    fn deliver(&self, live: &mut LiveInstance, name: &str, payload: &str) -> Delivery {
        if let Err(e) = live.store.set_fuel(FUEL_PER_DELIVERY) {
            return Delivery::Strike(format!("set_fuel: {e}"));
        }
        let (name_ptr, name_len) = match write_guest_buffer(live, name.as_bytes()) {
            Ok(pair) => pair,
            Err(e) => return Delivery::Strike(format!("alloc event name: {e}")),
        };
        let (payload_ptr, payload_len) = match write_guest_buffer(live, payload.as_bytes()) {
            Ok(pair) => pair,
            Err(e) => return Delivery::Strike(format!("alloc event payload: {e}")),
        };
        let on_event = match live.instance.get_typed_func::<(i32, i32, i32, i32), i32>(
            &live.store,
            abi::EXPORT_ON_EVENT,
        ) {
            Ok(f) => f,
            Err(e) => return Delivery::Strike(format!("{}: {e}", abi::EXPORT_ON_EVENT)),
        };
        match on_event.call(
            &mut live.store,
            (name_ptr, name_len, payload_ptr, payload_len),
        ) {
            Ok(0) => Delivery::Ok,
            Ok(rc) => Delivery::Strike(format!("{} returned {rc}", abi::EXPORT_ON_EVENT)),
            Err(e) => Delivery::Strike(format!("{} trapped: {e}", abi::EXPORT_ON_EVENT)),
        }
    }
}

/// Call a no-arg `() -> i32` guest export.
fn call_typed0(
    store: &mut wasmi::Store<StoreData>,
    instance: &wasmi::Instance,
    name: &str,
) -> Result<i32, String> {
    instance
        .get_typed_func::<(), i32>(&*store, name)
        .map_err(|e| e.to_string())?
        .call(store, ())
        .map_err(|e| e.to_string())
}

/// Allocate via the guest's `rl_alloc` and copy `bytes` in. The guest owns
/// (and frees) the buffer per the ABI contract.
fn write_guest_buffer(live: &mut LiveInstance, bytes: &[u8]) -> Result<(i32, i32), String> {
    let len = i32::try_from(bytes.len()).map_err(|_| "buffer too large".to_string())?;
    let alloc = live
        .instance
        .get_typed_func::<i32, i32>(&live.store, abi::EXPORT_ALLOC)
        .map_err(|e| e.to_string())?;
    let ptr = alloc.call(&mut live.store, len).map_err(|e| e.to_string())?;
    if ptr == 0 {
        return Err("rl_alloc returned null".to_string());
    }
    let memory = live
        .instance
        .get_memory(&live.store, "memory")
        .ok_or_else(|| "no exported memory".to_string())?;
    memory
        .write(&mut live.store, ptr as usize, bytes)
        .map_err(|e| e.to_string())?;
    Ok((ptr, len))
}

fn read_guest_str(
    caller: &mut wasmi::Caller<'_, StoreData>,
    ptr: i32,
    len: i32,
) -> Option<String> {
    let memory = caller.get_export("memory")?.into_memory()?;
    let mut buf = vec![0u8; len.max(0) as usize];
    memory.read(&*caller, ptr.max(0) as usize, &mut buf).ok()?;
    String::from_utf8(buf).ok()
}

// ---------------------------------------------------------------------------
// host_call: the single dispatch path.

/// Entry point for the guest's `host_call` import. Returns the packed
/// pointer/length of a `HostCallResponse` JSON written into guest memory,
/// or 0 if even that could not be produced.
fn host_call_entry(
    caller: &mut wasmi::Caller<'_, StoreData>,
    req_ptr: i32,
    req_len: i32,
) -> i64 {
    let response = match read_guest_str(caller, req_ptr, req_len) {
        Some(raw) => match serde_json::from_str::<HostCallRequest>(&raw) {
            Ok(req) => {
                let token = caller.data().token.clone();
                dispatch_host_call(&req, &token)
            }
            Err(e) => HostCallResponse {
                status: 400,
                body: format!("{{\"error\":\"host_call request decode: {e}\"}}"),
            },
        },
        None => HostCallResponse {
            status: 400,
            body: "{\"error\":\"host_call request unreadable\"}".to_string(),
        },
    };
    let json = match serde_json::to_string(&response) {
        Ok(j) => j,
        Err(_) => return 0,
    };
    write_response_to_guest(caller, json.as_bytes()).unwrap_or(0)
}

/// Drive one request through the daemon's real router with the extension's
/// token attached. This is deliberately the ONLY way guest code reaches
/// host capabilities — authorization is `authorize()`'s, verbatim.
fn dispatch_host_call(req: &HostCallRequest, token: &str) -> HostCallResponse {
    let Some(router) = ROUTER.get() else {
        return HostCallResponse {
            status: 503,
            body: "{\"error\":\"daemon router not up yet\"}".to_string(),
        };
    };
    let method = match Method::from_bytes(req.method.as_bytes()) {
        Ok(m) => m,
        Err(_) => {
            return HostCallResponse {
                status: 400,
                body: "{\"error\":\"bad method\"}".to_string(),
            }
        }
    };
    if !req.path.starts_with('/') {
        return HostCallResponse {
            status: 400,
            body: "{\"error\":\"path must start with /\"}".to_string(),
        };
    }
    let mut builder = Request::builder()
        .method(method)
        .uri(&req.path)
        .header(header::AUTHORIZATION, format!("Bearer {token}"));
    if req.body.is_some() {
        builder = builder.header(header::CONTENT_TYPE, "application/json");
    }
    let http_req = match builder.body(axum::body::Body::from(
        req.body.clone().unwrap_or_default(),
    )) {
        Ok(mut r) => {
            // Handlers that read the TCP peer (plan/review holds) see a
            // loopback sentinel instead of a missing-extension 500.
            r.extensions_mut()
                .insert(ConnectInfo(SocketAddr::from(([127, 0, 0, 1], 0))));
            r
        }
        Err(e) => {
            return HostCallResponse {
                status: 400,
                body: format!("{{\"error\":\"bad request: {e}\"}}"),
            }
        }
    };
    let outcome = tauri::async_runtime::block_on(async {
        match tokio::time::timeout(HOST_CALL_TIMEOUT, router.clone().oneshot(http_req)).await {
            Err(_elapsed) => Err(format!(
                "host_call timed out after {}s",
                HOST_CALL_TIMEOUT.as_secs()
            )),
            Ok(Err(infallible)) => match infallible {},
            Ok(Ok(resp)) => {
                let status = resp.status().as_u16();
                match axum::body::to_bytes(resp.into_body(), HOST_CALL_RESP_CAP).await {
                    Ok(bytes) => Ok(HostCallResponse {
                        status,
                        body: String::from_utf8_lossy(&bytes).to_string(),
                    }),
                    Err(e) => Err(format!("response body: {e}")),
                }
            }
        }
    });
    match outcome {
        Ok(resp) => resp,
        Err(e) => {
            crate::db::note_friction("extension_host_call_failed", Some("extensions"), None, Some(&e));
            HostCallResponse {
                status: 502,
                body: format!("{{\"error\":\"{e}\"}}"),
            }
        }
    }
}

/// Write the response into guest memory via the guest's own `rl_alloc`
/// (re-entrant through the caller) and pack the pointer/length.
fn write_response_to_guest(
    caller: &mut wasmi::Caller<'_, StoreData>,
    bytes: &[u8],
) -> Option<i64> {
    let len = i32::try_from(bytes.len()).ok()?;
    let alloc = caller
        .get_export(abi::EXPORT_ALLOC)?
        .into_func()?
        .typed::<i32, i32>(&*caller)
        .ok()?;
    let ptr = alloc.call(&mut *caller, len).ok()?;
    if ptr == 0 {
        return None;
    }
    let memory = caller.get_export("memory")?.into_memory()?;
    memory.write(&mut *caller, ptr as usize, bytes).ok()?;
    Some(abi::pack_ptr_len(ptr as u32, len as u32))
}

// ---------------------------------------------------------------------------
// Dispatcher.

/// Ensure a live instance exists, striking (and possibly disabling) on
/// failure. Terminal load errors (missing/oversized/uncompilable module)
/// mark the extension Failed and return None without striking — rebuilding
/// cannot change the bytes.
fn dispatcher_loop(state: Arc<ExtensionState>) {
    let Some(module_path) = state.module.clone() else {
        state.set_status(Status::Failed("manifest has no module".to_string()));
        notify_changed();
        return;
    };
    let runtime = match Runtime::load(&state.name, &module_path) {
        Ok(rt) => rt,
        Err(e) => {
            tracing::warn!("extension {}: {e}", state.name);
            crate::db::note_friction(
                "extension_load_failed",
                Some("extensions"),
                None,
                Some(&format!("{}: {e}", state.name)),
            );
            state.set_status(Status::Failed(e));
            notify_changed();
            return;
        }
    };
    let mut live: Option<LiveInstance> = None;
    loop {
        if !matches!(state.status(), Status::Starting | Status::Running) {
            return;
        }
        // (Re)build the instance if a strike poisoned it (or first run).
        if live.is_none() {
            let built = catch_unwind(AssertUnwindSafe(|| {
                runtime.instantiate(&state.name, &state.token)
            }));
            match built {
                Ok(Ok(instance)) => {
                    live = Some(instance);
                    state.set_status(Status::Running);
                    notify_changed();
                }
                Ok(Err(why)) => {
                    if state.strike(&why) {
                        return;
                    }
                    continue;
                }
                Err(_panic) => {
                    if state.strike("glue panicked during instantiate") {
                        return;
                    }
                    continue;
                }
            }
        }
        let Some((name, payload)) = state.queue.pop() else {
            return; // closed: disabled or removed
        };
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            runtime.deliver(live.as_mut().expect("live instance"), &name, &payload)
        }));
        match outcome {
            Ok(Delivery::Ok) => {}
            Ok(Delivery::Strike(why)) => {
                live = None; // poisoned — fresh instance next round
                if state.strike(&why) {
                    return;
                }
            }
            Err(_panic) => {
                live = None;
                if state.strike("glue panicked during delivery") {
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::routing::post;
    use std::sync::Mutex as StdMutex;

    // ------------------------------------------------------------------
    // Shared test router: the REAL auth middleware over a capture handler,
    // installed once into the process-global ROUTER cell (all wat tests
    // share it, exactly like production shares one router).

    struct Captured {
        session_id: String,
        bearer: Option<String>,
        body: String,
    }

    static CAPTURED: StdMutex<Vec<Captured>> = StdMutex::new(Vec::new());

    async fn capture_comment(
        axum::extract::Path(session_id): axum::extract::Path<String>,
        headers: axum::http::HeaderMap,
        body: String,
    ) -> impl axum::response::IntoResponse {
        let bearer = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_string());
        CAPTURED.lock().unwrap().push(Captured {
            session_id,
            bearer,
            body,
        });
        (
            axum::http::StatusCode::CREATED,
            axum::Json(serde_json::json!({ "id": "c1" })),
        )
    }

    fn install_test_router() {
        let router = axum::Router::new()
            .route(
                "/v1/sessions/:session_id/comments",
                post(capture_comment),
            )
            // Registered in the router but NOT in ROUTE_TABLE — exercises
            // the fail-closed rule end-to-end from guest code.
            .route(
                "/v1/not/in/contract",
                post(|| async { "should never be reachable" }),
            )
            .layer(axum::middleware::from_fn(
                crate::auth::require_daemon_auth,
            ));
        install_router(router); // idempotent; all tests share it
    }

    // ------------------------------------------------------------------
    // Fixtures: real wasm modules assembled from wat. The poster fixture
    // makes one host_call (request embedded as a data segment), extracts
    // the 3-digit status from the response JSON (`{"status":NNN` — serde
    // field order is declaration order, so the offset is stable), returns
    // 0 on the expected status and the status itself otherwise.

    fn wat_escape(s: &str) -> String {
        s.replace('\\', "\\\\").replace('"', "\\\"")
    }

    fn poster_fixture(req: &HostCallRequest, expect_status: u16) -> Vec<u8> {
        let json = serde_json::to_string(req).unwrap();
        let wat = format!(
            r#"(module
  (import "redline" "host_call" (func $host_call (param i32 i32) (result i64)))
  (memory (export "memory") 4)
  (global $bump (mut i32) (i32.const 4096))
  (data (i32.const 0) "{data}")
  (func (export "rl_api_version") (result i32) (i32.const 1))
  (func (export "rl_alloc") (param $len i32) (result i32)
    (local $ptr i32)
    (local.set $ptr (global.get $bump))
    (global.set $bump (i32.add (global.get $bump) (local.get $len)))
    (local.get $ptr))
  (func (export "rl_free") (param i32) (param i32))
  (func (export "rl_init") (result i32) (i32.const 0))
  (func (export "rl_on_event") (param i32 i32 i32 i32) (result i32)
    (local $packed i64)
    (local $ptr i32)
    (local $status i32)
    (local.set $packed (call $host_call (i32.const 0) (i32.const {len})))
    (if (i64.eqz (local.get $packed)) (then (return (i32.const 599))))
    (local.set $ptr (i32.wrap_i64 (i64.shr_u (local.get $packed) (i64.const 32))))
    (local.set $status (i32.add
      (i32.mul (i32.const 100) (i32.sub (i32.load8_u (i32.add (local.get $ptr) (i32.const 10))) (i32.const 48)))
      (i32.add
        (i32.mul (i32.const 10) (i32.sub (i32.load8_u (i32.add (local.get $ptr) (i32.const 11))) (i32.const 48)))
        (i32.sub (i32.load8_u (i32.add (local.get $ptr) (i32.const 12))) (i32.const 48)))))
    (if (i32.eq (local.get $status) (i32.const {expect})) (then (return (i32.const 0))))
    (local.get $status)))
"#,
            data = wat_escape(&json),
            len = json.len(),
            expect = expect_status,
        );
        wat::parse_str(&wat).expect("fixture wat must assemble")
    }

    fn comment_request(session: &str) -> HostCallRequest {
        HostCallRequest {
            method: "POST".to_string(),
            path: format!("/v1/sessions/{session}/comments"),
            body: Some("{\"body\":\"hello from wasm\"}".to_string()),
        }
    }

    /// rl_on_event spins forever — the fuel budget is the only way out.
    fn spinner_fixture() -> Vec<u8> {
        wat::parse_str(
            r#"(module
  (memory (export "memory") 1)
  (func (export "rl_api_version") (result i32) (i32.const 1))
  (func (export "rl_alloc") (param i32) (result i32) (i32.const 8))
  (func (export "rl_free") (param i32) (param i32))
  (func (export "rl_init") (result i32) (i32.const 0))
  (func (export "rl_on_event") (param i32 i32 i32 i32) (result i32)
    (loop $spin (br $spin))
    (i32.const 0)))
"#,
        )
        .unwrap()
    }

    fn drain_captured() -> Vec<Captured> {
        std::mem::take(&mut *CAPTURED.lock().unwrap())
    }

    fn test_state(name: &str, events: &[&str], token: &str) -> Arc<ExtensionState> {
        Arc::new(ExtensionState {
            name: name.to_string(),
            version: None,
            kind: crate::extension::KIND_WASM.to_string(),
            scopes: vec![],
            events: events.iter().map(|e| e.to_string()).collect(),
            dir: std::env::temp_dir(),
            module: None,
            token: token.to_string(),
            status: Mutex::new(Status::Starting),
            strikes: AtomicU32::new(0),
            last_strike: Mutex::new(None),
            panel: Mutex::new(None),
            queue: EventQueue::new(),
        })
    }

    // ------------------------------------------------------------------

    #[test]
    fn granted_scope_call_succeeds_against_the_real_router() {
        let _guard = crate::auth::grants_test_lock();
        crate::auth::clear_grants_for_test();
        install_test_router();
        crate::auth::register_grant(
            "tok-granted".to_string(),
            crate::auth::ExtensionGrant {
                name: "greeter".to_string(),
                scopes: vec![crate::auth::SCOPE_PLAN_COMMENT.to_string()],
            },
        );
        drain_captured();

        let wasm = poster_fixture(&comment_request("wasm-e2e"), 201);
        let rt = Runtime::from_bytes("greeter", &wasm).unwrap();
        let mut live = rt.instantiate("greeter", "tok-granted").unwrap();
        let outcome = rt.deliver(&mut live, "plan.received", "{}");
        assert_eq!(outcome, Delivery::Ok, "delivery must succeed");

        let captured = drain_captured();
        assert_eq!(captured.len(), 1, "the real handler must be reached");
        assert_eq!(captured[0].session_id, "wasm-e2e");
        assert!(captured[0].body.contains("hello from wasm"));
        assert_eq!(
            captured[0].bearer.as_deref(),
            Some("Bearer tok-granted"),
            "host_call must attach the extension's own token"
        );
        crate::auth::clear_grants_for_test();
    }

    #[test]
    fn ungranted_scope_is_denied_by_the_real_middleware() {
        let _guard = crate::auth::grants_test_lock();
        crate::auth::clear_grants_for_test();
        install_test_router();
        crate::auth::register_grant(
            "tok-drive-only".to_string(),
            crate::auth::ExtensionGrant {
                name: "driver".to_string(),
                scopes: vec![crate::auth::SCOPE_BROWSER_DRIVE.to_string()],
            },
        );
        drain_captured();

        let wasm = poster_fixture(&comment_request("wasm-denied"), 201);
        let rt = Runtime::from_bytes("driver", &wasm).unwrap();
        let mut live = rt.instantiate("driver", "tok-drive-only").unwrap();
        match rt.deliver(&mut live, "plan.received", "{}") {
            Delivery::Strike(why) => assert!(
                why.contains("401"),
                "guest must observe the 401 (got: {why})"
            ),
            other => panic!("expected a strike carrying 401, got {other:?}"),
        }
        assert!(
            drain_captured().is_empty(),
            "the handler must never run on a scope denial"
        );
        crate::auth::clear_grants_for_test();
    }

    #[test]
    fn route_missing_from_contract_fails_closed() {
        let _guard = crate::auth::grants_test_lock();
        crate::auth::clear_grants_for_test();
        install_test_router();
        drain_captured();

        // Even the master token cannot reach a route with no ROUTE_TABLE row.
        let req = HostCallRequest {
            method: "POST".to_string(),
            path: "/v1/not/in/contract".to_string(),
            body: Some("{}".to_string()),
        };
        let wasm = poster_fixture(&req, 201);
        let rt = Runtime::from_bytes("prober", &wasm).unwrap();
        let mut live = rt
            .instantiate("prober", crate::auth::daemon_token())
            .unwrap();
        match rt.deliver(&mut live, "plan.received", "{}") {
            Delivery::Strike(why) => {
                assert!(why.contains("401"), "unknown route must 401 (got: {why})")
            }
            other => panic!("expected fail-closed 401 strike, got {other:?}"),
        }
        crate::auth::clear_grants_for_test();
    }

    #[test]
    fn fuel_exhaustion_is_a_strike_and_three_disable() {
        let wasm = spinner_fixture();
        let rt = Runtime::from_bytes("spinner", &wasm).unwrap();
        let state = test_state("spinner", &["plan.received"], "tok-unused");

        for round in 1..=STRIKES_TO_DISABLE {
            let mut live = rt.instantiate("spinner", "tok-unused").unwrap();
            match rt.deliver(&mut live, "plan.received", "{}") {
                Delivery::Strike(why) => {
                    let disabled = state.strike(&why);
                    assert_eq!(
                        disabled,
                        round == STRIKES_TO_DISABLE,
                        "only the third strike disables"
                    );
                }
                other => panic!("spin must exhaust fuel, got {other:?}"),
            }
        }
        assert!(matches!(state.status(), Status::Disabled(_)));
        assert!(
            state.queue.pop().is_none(),
            "a disabled extension's queue is closed"
        );
    }

    #[test]
    fn queue_drops_oldest_on_overflow_and_close_drains() {
        let q = EventQueue::new();
        for i in 0..QUEUE_CAP {
            assert!(!q.push(format!("e{i}"), "{}".to_string()));
        }
        assert!(
            q.push("newest".to_string(), "{}".to_string()),
            "overflow must report the drop"
        );
        let (first, _) = q.pop().unwrap();
        assert_eq!(first, "e1", "e0 (the oldest) must have been dropped");
        q.close();
        // Remaining items still drain after close; then None.
        let mut rest = 0;
        while q.pop().is_some() {
            rest += 1;
        }
        assert_eq!(rest, QUEUE_CAP - 1);
    }

    /// The automated end-to-end: publish → per-extension queue → dispatcher
    /// thread → wasmi delivery → host_call → real middleware + router →
    /// capture handler. The template-extension GUI walk stays manual, but
    /// the full machine path is pinned here.
    #[test]
    fn publish_reaches_the_router_end_to_end() {
        let _guard = crate::auth::grants_test_lock();
        crate::auth::clear_grants_for_test();
        install_test_router();
        crate::auth::register_grant(
            "tok-e2e".to_string(),
            crate::auth::ExtensionGrant {
                name: "e2e-ext".to_string(),
                scopes: vec![crate::auth::SCOPE_PLAN_COMMENT.to_string()],
            },
        );
        drain_captured();

        // A real module file on disk, like a real install.
        let wasm = poster_fixture(&comment_request("wasm-pipeline"), 201);
        let dir = std::env::temp_dir().join(format!("rl-ext-e2e-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let module_path = dir.join("extension.wasm");
        std::fs::write(&module_path, &wasm).unwrap();

        let state = Arc::new(ExtensionState {
            name: "e2e-ext".to_string(),
            version: None,
            kind: crate::extension::KIND_WASM.to_string(),
            scopes: vec![crate::auth::SCOPE_PLAN_COMMENT.to_string()],
            events: vec![redline_extension_abi::events::PLAN_RECEIVED.to_string()],
            dir: dir.clone(),
            module: Some(module_path),
            token: "tok-e2e".to_string(),
            status: Mutex::new(Status::Starting),
            strikes: AtomicU32::new(0),
            last_strike: Mutex::new(None),
            panel: Mutex::new(None),
            queue: EventQueue::new(),
        });
        registry().exts.write().unwrap().push(state.clone());

        publish(
            redline_extension_abi::events::PLAN_RECEIVED,
            &redline_extension_abi::events::PlanReceived {
                session_id: "wasm-pipeline".to_string(),
                version: 1,
                is_new_session: true,
                thread_start: true,
                mode: "revise".to_string(),
                restored: false,
                ts_ms: now_ms(),
            },
        );

        let worker = {
            let state = state.clone();
            std::thread::spawn(move || dispatcher_loop(state))
        };
        // Give the delivery a bounded window, then close the queue so the
        // dispatcher exits.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if !CAPTURED.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        state.queue.close();
        worker.join().expect("dispatcher must exit cleanly");

        let captured = drain_captured();
        assert_eq!(captured.len(), 1, "published event must reach the handler");
        assert_eq!(captured[0].session_id, "wasm-pipeline");
        assert_eq!(state.strikes.load(Ordering::SeqCst), 0);

        registry()
            .exts
            .write()
            .unwrap()
            .retain(|e| e.name != "e2e-ext");
        crate::auth::clear_grants_for_test();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// B4 hot-install: `load_one` registers at runtime, spawns the
    /// dispatcher, and the very next publish reaches the real router —
    /// no relaunch anywhere. Duplicate names are refused (updates remove
    /// the old registration first), and `remove` hands back the dir.
    #[test]
    fn load_one_hot_registers_and_delivers() {
        let _guard = crate::auth::grants_test_lock();
        crate::auth::clear_grants_for_test();
        install_test_router();
        crate::auth::register_grant(
            "tok-hot".to_string(),
            crate::auth::ExtensionGrant {
                name: "hot-ext".to_string(),
                scopes: vec![crate::auth::SCOPE_PLAN_COMMENT.to_string()],
            },
        );
        drain_captured();

        let wasm = poster_fixture(&comment_request("hot-install"), 201);
        let dir = std::env::temp_dir().join(format!("rl-ext-hot-{}", uuid::Uuid::new_v4()));
        let ext_dir = dir.join("hot-ext");
        std::fs::create_dir_all(&ext_dir).unwrap();
        std::fs::write(ext_dir.join("extension.wasm"), &wasm).unwrap();
        let manifest_json = r#"{"name":"hot-ext","kind":"wasm","module":"extension.wasm","api_version":1,"scopes":["plan.comment"],"events":["plan.received"]}"#;
        std::fs::write(ext_dir.join("extension.json"), manifest_json).unwrap();

        let booted = || crate::extension::BootedExtension {
            ext: crate::extension::load_extension_dir(&ext_dir).unwrap(),
            token: "tok-hot".to_string(),
        };
        load_one(booted(), false).unwrap();
        assert!(
            load_one(booted(), false).is_err(),
            "a duplicate name must be refused"
        );

        publish(
            redline_extension_abi::events::PLAN_RECEIVED,
            &redline_extension_abi::events::PlanReceived {
                session_id: "hot-install".to_string(),
                version: 1,
                is_new_session: true,
                thread_start: true,
                mode: "revise".to_string(),
                restored: false,
                ts_ms: now_ms(),
            },
        );
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if !CAPTURED.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let captured = drain_captured();
        assert_eq!(captured.len(), 1, "hot-installed extension must deliver");
        assert_eq!(captured[0].session_id, "hot-install");

        let removed = remove("hot-ext").unwrap();
        assert_eq!(removed, ext_dir);
        crate::auth::clear_grants_for_test();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The publisher-story smoke: the REAL template artifact (SDK `export!`
    /// bridge, not a wat fixture) instantiates, receives `plan.received`,
    /// and lands its comment through the genuine middleware. Ignored by
    /// default because the artifact is a build product — run it after
    /// `marketplace/redline-extension-template/build.sh`:
    /// `cargo test -- --ignored template_artifact`.
    #[test]
    #[ignore]
    fn template_artifact_delivers_through_the_sdk_bridge() {
        let wasm = std::fs::read(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../marketplace/redline-extension-template/extension.wasm"),
        )
        .expect("build the template first: marketplace/redline-extension-template/build.sh");

        let _guard = crate::auth::grants_test_lock();
        crate::auth::clear_grants_for_test();
        install_test_router();
        crate::auth::register_grant(
            "tok-template".to_string(),
            crate::auth::ExtensionGrant {
                name: "plan-greeter".to_string(),
                scopes: vec![crate::auth::SCOPE_PLAN_COMMENT.to_string()],
            },
        );
        drain_captured();

        let rt = Runtime::from_bytes("plan-greeter", &wasm).unwrap();
        let mut live = rt.instantiate("plan-greeter", "tok-template").unwrap();
        let payload = serde_json::to_string(&redline_extension_abi::events::PlanReceived {
            session_id: "tmpl-e2e".to_string(),
            version: 7,
            is_new_session: false,
            thread_start: false,
            mode: "revise".to_string(),
            restored: false,
            ts_ms: now_ms(),
        })
        .unwrap();
        let outcome = rt.deliver(
            &mut live,
            redline_extension_abi::events::PLAN_RECEIVED,
            &payload,
        );
        assert_eq!(outcome, Delivery::Ok, "template delivery must succeed");

        let captured = drain_captured();
        assert_eq!(captured.len(), 1, "the template's comment must land");
        assert_eq!(captured[0].session_id, "tmpl-e2e");
        assert!(captured[0].body.contains("plan v7 received"));
        assert_eq!(captured[0].bearer.as_deref(), Some("Bearer tok-template"));
        crate::auth::clear_grants_for_test();
    }

    #[test]
    fn sanitize_panel_caps_and_strips_control() {
        let dirty = "safe **md**\u{0007}\u{001b}[31m\nline\ttab";
        assert_eq!(sanitize_panel(dirty), "safe **md**[31m\nline\ttab");
        let big = "x".repeat(PANEL_CAP_BYTES + 10);
        let cut = sanitize_panel(&big);
        assert!(cut.len() < PANEL_CAP_BYTES + 64);
        assert!(cut.ends_with("… (truncated at 32 KB)"));
    }

    /// Every closed-vocabulary event has its enqueue-only tap sitting beside
    /// the existing frontend emit for the same moment — counted per source
    /// file so a new emit site cannot land without its tap.
    #[test]
    fn every_known_event_has_a_tap_beside_its_emit_site() {
        let lib = include_str!("lib.rs");
        let ai_review = include_str!("ai_review.rs");
        let review = include_str!("review.rs");
        let keeper = include_str!("keeper.rs");

        let count = |hay: &str, needle: &str| hay.matches(needle).count();

        // (event const reference, emit string, per-file expectations)
        let lib_cases = [
            ("ext_events::PLAN_RECEIVED", "emit(\"plan-received\""),
            ("ext_events::REVIEW_STARTED", "emit(\"review-requested\""),
            (
                "ext_events::REVIEW_ANNOTATIONS_CHANGED",
                "emit(\"review-annotations-changed\"",
            ),
            ("ext_events::COMMENT_OFFER", "emit(\"comment-offer\""),
            ("ext_events::LEDGER_CHANGED", "emit(\"ledger-changed\""),
        ];
        for (tap, emit) in lib_cases {
            // Each tap references its event const exactly once (the payload
            // struct is CamelCase, so the SHOUTY const cannot double-count).
            assert_eq!(
                count(lib, tap),
                count(lib, emit),
                "lib.rs: every `{emit}` site needs an adjacent publish({tap}) tap"
            );
        }
        // suggestion.resolved has no frontend emit — the resolve command is
        // its moment; require the tap itself.
        assert!(
            lib.contains("ext_events::SUGGESTION_RESOLVED"),
            "lib.rs: draft_suggestion_resolve must publish suggestion.resolved"
        );
        // The three emit sites living outside lib.rs.
        assert_eq!(
            count(ai_review, "emit(\"review-annotations-changed\""),
            count(ai_review, "events::REVIEW_ANNOTATIONS_CHANGED"),
            "ai_review.rs: annotation emit needs its tap"
        );
        assert_eq!(
            count(review, "emit(\"review-annotations-changed\""),
            count(review, "events::REVIEW_ANNOTATIONS_CHANGED"),
            "review.rs: annotation emit needs its tap"
        );
        assert_eq!(
            count(keeper, "emit(\"ledger-changed\""),
            count(keeper, "events::LEDGER_CHANGED"),
            "keeper.rs: ledger emit needs its tap"
        );
        // And the closed vocabulary itself is fully covered: every known
        // event name appears in at least one publish tap across the app.
        for name in redline_extension_abi::events::KNOWN_EVENTS {
            let const_name = name.replace('.', "_").to_uppercase();
            let everywhere = [lib, ai_review, review, keeper]
                .iter()
                .any(|src| src.contains(&const_name));
            assert!(everywhere, "event {name} has no publish tap anywhere");
        }
    }
}
