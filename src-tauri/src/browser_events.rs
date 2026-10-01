// SPDX-License-Identifier: Apache-2.0
//! Bounded page events. This channel exposes no Tauri commands or filesystem access.
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

static INPUT: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
pub fn input_revision(label: &str) -> u64 {
    *INPUT.get_or_init(Default::default).lock().unwrap().get(label).unwrap_or(&0)
}
fn note_input(label: &str) {
    let mut values = INPUT.get_or_init(Default::default).lock().unwrap();
    let revision = values.entry(label.to_owned()).or_default();
    *revision = revision.saturating_add(1);
}
fn browser_label(label: &str) -> bool { label.starts_with("browser-") && label.len() > 8 && label.len() <= 160 }
fn page_url(url: &str) -> bool {
    url.len() <= 8192 && (url == "about:blank" || tauri::Url::parse(url).is_ok_and(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some()))
}
pub fn parse_signal(raw: &str) -> Option<Value> {
    if raw.len() > 24_000 { return None; }
    let value: Value = serde_json::from_str(raw).ok()?;
    match value.get("kind")?.as_str()? {
        "state" => {
            let url = value.get("url")?.as_str()?;
            if !page_url(url) { return None; }
            if value.get("title")?.as_str()?.len() > 1024 || value.get("revision")?.as_str()?.len() > 128 { return None; }
            if value.get("fullscreen").is_some_and(|flag| !flag.is_boolean()) { return None; }
        }
        "tabs" => { let url = value.get("value")?.as_str()?; if !page_url(url) || url == "about:blank" { return None; } }
        "selection" => {
            let payload = value.get("value")?.as_object()?;
            if !["ask", "define", "explain", "research", "list"].contains(&payload.get("action")?.as_str()?) { return None; }
            let text = payload.get("text")?.as_str()?;
            if text.is_empty() || text.chars().count() > 4001 { return None; }
        }
        "inspect" => {
            let payload = value.get("value")?.as_object()?;
            if !page_url(payload.get("url")?.as_str()?) || payload.get("revision")?.as_str()?.len() > 128 { return None; }
            if payload.get("accessibleName")?.as_str()?.chars().count() > 160 || payload.get("markup")?.as_str()?.chars().count() > 4000 { return None; }
            let selectors = payload.get("selectors")?.as_array()?;
            if selectors.len() > 8 || selectors.iter().any(|selector| selector.as_str().is_none_or(|s| s.len() > 4096)) { return None; }
        }
        "shortcut" => { if !["location", "new-tab", "close-tab", "next-tab", "previous-tab", "exit-focus", "toggle-video-screen", "toggle-monochat", "open-front-door"].contains(&value.get("value")?.as_str()?) { return None; } }
        "focus" | "interaction" => {}
        _ => return None,
    }
    // Do not forward arbitrary additional top-level page fields into app events.
    let mut bounded = serde_json::Map::new();
    for key in ["kind", "value", "url", "title", "revision", "fullscreen"] {
        if let Some(field) = value.get(key) { bounded.insert(key.to_owned(), field.clone()); }
    }
    Some(Value::Object(bounded))
}

fn signal_for_pane(raw: &str) -> Option<Value> {
    if let Some(value) = parse_signal(raw) { return Some(value); }
    // Keep malformed page data out of logs and app events. The fixed error
    // lets an active picker surface rejection instead of silently dropping it.
    let inspector = raw.trim_start().starts_with("{\"kind\":\"inspect\"")
        || (raw.len() <= 64_000 && serde_json::from_str::<Value>(raw).ok()
            .is_some_and(|value| value["kind"] == "inspect"));
    tracing::warn!(bytes = raw.len(), inspector, "rejected browser page signal");
    inspector.then(|| serde_json::json!({ "kind": "inspect-error", "value": "Element picking isn't available on this page" }))
}

fn signal_for_frame(raw: &str, main_frame: bool) -> Option<Value> {
    let value = signal_for_pane(raw)?;
    // Subframes may summon the front door. All other browser actions and
    // page-state updates remain restricted to the main frame.
    (main_frame || (value["kind"] == "shortcut" && value["value"] == "open-front-door")).then_some(value)
}
#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::cell::RefCell;
    use std::time::Instant;
    use objc2::{define_class, msg_send, DefinedClass, MainThreadOnly};
    use objc2::rc::Retained;
    use objc2::runtime::{NSObject, ProtocolObject};
    use objc2_foundation::{MainThreadMarker, NSObjectProtocol, NSString};
    use objc2_web_kit::{WKScriptMessage, WKScriptMessageHandler, WKUserContentController, WKWebView};
    use tauri::Emitter;
    struct Ivars { app: tauri::AppHandle, label: String, throttle: RefCell<(Instant, u32)> }
    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = Ivars]
        struct BrowserSignals;
        unsafe impl NSObjectProtocol for BrowserSignals {}
        unsafe impl WKScriptMessageHandler for BrowserSignals {
            #[unsafe(method(userContentController:didReceiveScriptMessage:))]
            unsafe fn receive(&self, _controller: &WKUserContentController, message: &WKScriptMessage) {
                let mut throttle = self.ivars().throttle.borrow_mut();
                if throttle.0.elapsed().as_secs() >= 1 { *throttle = (Instant::now(), 0); }
                if throttle.1 >= 60 { return; }
                throttle.1 += 1;
                drop(throttle);
                let body = message.body();
                let Some(raw) = body.downcast_ref::<NSString>() else { return; };
                let Some(mut value) = signal_for_frame(&raw.to_string(), message.frameInfo().isMainFrame()) else { return; };
                if value["kind"] == "interaction" || value["kind"] == "shortcut" { note_input(&self.ivars().label); }
                value["label"] = Value::String(self.ivars().label.clone());
                let _ = self.ivars().app.emit_to("main", "browser-page-event", value);
            }
        }
    );
    pub fn install(app: tauri::AppHandle, view: &tauri::Webview) -> Result<(), String> {
        let label = view.label().to_owned();
        view.with_webview(move |native| {
            let Some(mtm) = MainThreadMarker::new() else { return; };
            unsafe {
                let Some(webview) = (native.inner() as *mut WKWebView).as_ref() else { return; };
                let controller = webview.configuration().userContentController();
                let name = NSString::from_str("redlineBrowser");
                controller.removeScriptMessageHandlerForName(&name);
                let handler = mtm.alloc::<BrowserSignals>().set_ivars(Ivars { app, label, throttle: RefCell::new((Instant::now(), 0)) });
                let handler: Retained<BrowserSignals> = msg_send![super(handler), init];
                controller.addScriptMessageHandler_name(ProtocolObject::from_ref(&*handler), &name);
            }
        }).map_err(|e| e.to_string())
    }
}
#[cfg(target_os = "macos")]
pub use native::install;

#[tauri::command]
pub fn browser_inspect(app: tauri::AppHandle, label: String) -> Result<(), String> {
    use tauri::Manager;
    if !browser_label(&label) { return Err("A browser page target is required".into()); }
    let view = app.get_webview(&label).ok_or("This page is no longer open")?;
    if !matches!(view.url().map_err(|e| e.to_string())?.scheme(), "http" | "https") {
        return Err("Element picking isn't available on this page".into());
    }
    view.eval(include_str!("browser_inspector.js")).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_set_appearance(app: tauri::AppHandle, label: String, website: String, zoom: f64) -> Result<(), String> {
    use tauri::Manager;
    if !browser_label(&label) || !["default", "light", "dark", "forced"].contains(&website.as_str()) { return Err("Invalid browser appearance target".into()); }
    if !zoom.is_finite() || !(0.5..=3.0).contains(&zoom) { return Err("Invalid page zoom".into()); }
    let view = app.get_webview(&label).ok_or("Page is no longer open")?;
    view.set_zoom(zoom).map_err(|e| e.to_string())?;
    #[cfg(target_os="macos")]
    view.with_webview(move |native| unsafe {
        let ptr = native.inner() as *mut objc2::runtime::AnyObject;
        let appearance: *mut objc2::runtime::AnyObject = match website.as_str() {
            "dark" => objc2::msg_send![objc2::class!(NSAppearance), appearanceNamed: crate::ns_string("NSAppearanceNameDarkAqua")],
            "light" => objc2::msg_send![objc2::class!(NSAppearance), appearanceNamed: crate::ns_string("NSAppearanceNameAqua")],
            _ => std::ptr::null_mut(),
        };
        let _: () = objc2::msg_send![ptr, setAppearance: appearance];
    }).map_err(|e| e.to_string())?;
    #[cfg(not(target_os="macos"))] let _ = website;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn signals_are_bounded_and_cannot_invoke_commands() {
        assert!(parse_signal(r#"{"kind":"invoke","command":"read_file"}"#).is_none());
        assert!(parse_signal(r#"{"kind":"tabs","value":"file:///etc/passwd"}"#).is_none());
        assert!(parse_signal(&"x".repeat(24_001)).is_none());
        assert!(parse_signal(r#"{"kind":"tabs","value":"https://example.org"}"#).is_some());
        assert!(parse_signal(r#"{"kind":"tabs","value":"https://"}"#).is_none());
        assert!(parse_signal(r#"{"kind":"inspect","value":{"command":"read_file"}}"#).is_none());
        assert!(parse_signal(r#"{"kind":"shortcut","value":"toggle-focus"}"#).is_none());
        assert!(parse_signal(r#"{"kind":"shortcut","value":"toggle-video-screen"}"#).is_some());
        assert!(parse_signal(r#"{"kind":"focus","command":"read_file"}"#).unwrap().get("command").is_none());
        assert!(parse_signal(r#"{"kind":"shortcut","value":"toggle-monochat"}"#).is_some());
        assert!(parse_signal(r#"{"kind":"shortcut","value":"open-front-door"}"#).is_some());
        assert!(!browser_label("main")); assert!(!browser_label("browser-"));
    }

    #[test]
    fn subframes_can_only_summon_the_front_door() {
        assert!(signal_for_frame(r#"{"kind":"shortcut","value":"open-front-door"}"#, false).is_some());
        for raw in [
            r#"{"kind":"shortcut","value":"close-tab"}"#,
            r#"{"kind":"shortcut","value":"toggle-monochat"}"#,
            r#"{"kind":"tabs","value":"https://example.org"}"#,
            r#"{"kind":"inspect","value":{"command":"read_file"}}"#,
        ] { assert!(signal_for_frame(raw, false).is_none()); }
        assert!(signal_for_frame(r#"{"kind":"shortcut","value":"close-tab"}"#, true).is_some());
    }

    #[test]
    fn rejected_inspector_signals_become_fixed_errors() {
        let raw = r#"{"kind":"inspect","value":{"url":"file:///private","secret":"do not forward"}}"#;
        let error = signal_for_pane(raw).unwrap();
        assert_eq!(error["kind"], "inspect-error");
        assert!(!error.to_string().contains("private"));
        assert!(!error.to_string().contains("secret"));
        assert!(signal_for_pane(r#"{"kind":"invoke"}"#).is_none());
    }
}
