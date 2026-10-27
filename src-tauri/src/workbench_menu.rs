// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The shells' menu accelerators, as native menu items. A menu key
//! equivalent fires whatever has focus — an embedded browser page included,
//! where no listener of the app's own document can hear the keyboard at
//! all — the same reason ⌘W is a menu item (lib.rs).
//!
//! Two sets, mutually exclusive:
//!
//! - **Flow** (until W2 deletes that shell): ⌘N for a new session and ⌘1–⌘4
//!   for the Tools (Browser, Prompt Drafter, Code Review, Localhost).
//! - **Workbench**: File ▸ New Tab ⌘T, Reopen Closed Tab ⌘⇧T, Close Window
//!   ⌘⇧W, and a Tabs submenu — Previous / Next Tab ⌘⇧[ / ⌘⇧], Tab 1–8
//!   ⌘1–⌘8, Last Tab ⌘9. (⌘⌥← / ⌘⌥→ are aliases of the cycle, matched by
//!   the frontend and forwarded from pages by browser_signals.js: a menu item
//!   carries one accelerator.) ⌘W stays the "Close" item lib.rs installs at
//!   setup; the frontend closes from the inside out — browser page → pane →
//!   tab — and never the window.
//!
//! The shell is a frontend choice (lib/shellFlag, read once per page load),
//! so the menu learns it from the frontend: the flow shell calls
//! `set_flow_menu(true)` as it mounts, the workbench `set_workbench_menu(true)`,
//! and Settings → Shell turns the leaving shell's off before reloading.
//! Enabling one set removes the other (flow's ⌘1–4 Tools collide with the
//! workbench's ⌘1–8 tabs). Idempotent both ways: a reload, or React running
//! an effect twice, finds the items already in (or already out of) place.

use tauri::menu::{MenuItemBuilder, MenuItemKind, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

// ---- The flow set -------------------------------------------------------------

/// File ▸ New Session (⌘N).
pub const NEW_SESSION_ID: &str = "flow_new_session";
/// The Tools submenu, between Edit and View.
pub const TOOLS_MENU_ID: &str = "flow_tools";

/// The Tools items: menu id, label, accelerator, and the ⌘ number the
/// frontend maps to a tool (config/workspace `toolForKey`, which also knows
/// which tools the workspace manifest switched off).
pub const TOOL_ITEMS: [(&str, &str, &str, u8); 4] = [
    ("flow_tool_1", "Browser", "CmdOrCtrl+1", 1),
    ("flow_tool_2", "Prompt Drafter", "CmdOrCtrl+2", 2),
    ("flow_tool_3", "Code Review", "CmdOrCtrl+3", 3),
    ("flow_tool_4", "Localhost", "CmdOrCtrl+4", 4),
];

// ---- The workbench set ----------------------------------------------------------

/// File ▸ New Tab (⌘T).
pub const WB_NEW_TAB_ID: &str = "wb_new_tab";
/// File ▸ Reopen Closed Tab (⌘⇧T).
pub const WB_REOPEN_TAB_ID: &str = "wb_reopen_tab";
/// File ▸ Close Window (⌘⇧W).
pub const WB_CLOSE_WINDOW_ID: &str = "wb_close_window";
/// The Tabs submenu, between Edit and View.
pub const WB_TABS_MENU_ID: &str = "wb_tabs";
/// Tabs ▸ Previous Tab (⌘⇧[).
pub const WB_PREV_TAB_ID: &str = "wb_prev_tab";
/// Tabs ▸ Next Tab (⌘⇧]).
pub const WB_NEXT_TAB_ID: &str = "wb_next_tab";
/// Tabs ▸ Last Tab (⌘9).
pub const WB_LAST_TAB_ID: &str = "wb_last_tab";

/// The File items of the workbench set, in menu order: id, label,
/// accelerator, the event each emits (no payload).
pub const WB_FILE_ITEMS: [(&str, &str, &str, &str); 3] = [
    (WB_NEW_TAB_ID, "New Tab", "CmdOrCtrl+T", "menu-new-tab"),
    (WB_REOPEN_TAB_ID, "Reopen Closed Tab", "CmdOrCtrl+Shift+T", "menu-reopen-tab"),
    (WB_CLOSE_WINDOW_ID, "Close Window", "CmdOrCtrl+Shift+W", "menu-close-window"),
];

/// Tabs ▸ Previous / Next: id, label, accelerator, the `menu-tab-cycle`
/// payload (−1 / +1).
pub const WB_CYCLE_ITEMS: [(&str, &str, &str, i32); 2] = [
    (WB_PREV_TAB_ID, "Previous Tab", "CmdOrCtrl+Shift+[", -1),
    (WB_NEXT_TAB_ID, "Next Tab", "CmdOrCtrl+Shift+]", 1),
];

/// Tabs ▸ Tab 1 … Tab 8, Last Tab: id, label, accelerator, the
/// `menu-tab-index` payload (0..7, −1 for the last tab).
pub const WB_INDEX_ITEMS: [(&str, &str, &str, i32); 9] = [
    ("wb_tab_1", "Tab 1", "CmdOrCtrl+1", 0),
    ("wb_tab_2", "Tab 2", "CmdOrCtrl+2", 1),
    ("wb_tab_3", "Tab 3", "CmdOrCtrl+3", 2),
    ("wb_tab_4", "Tab 4", "CmdOrCtrl+4", 3),
    ("wb_tab_5", "Tab 5", "CmdOrCtrl+5", 4),
    ("wb_tab_6", "Tab 6", "CmdOrCtrl+6", 5),
    ("wb_tab_7", "Tab 7", "CmdOrCtrl+7", 6),
    ("wb_tab_8", "Tab 8", "CmdOrCtrl+8", 7),
    (WB_LAST_TAB_ID, "Last Tab", "CmdOrCtrl+9", -1),
];

/// What a click on one of these items tells the frontend: the event, and
/// its number when it carries one — a flow tool's ⌘ number (1–4), a
/// workbench cycle direction (±1) or tab index (0..7, −1 = last). None for
/// every other menu id.
pub fn event_for(id: &str) -> Option<(&'static str, Option<i32>)> {
    if id == NEW_SESSION_ID {
        return Some(("menu-new-session", None));
    }
    if let Some((.., n)) = TOOL_ITEMS.iter().find(|(item, ..)| *item == id) {
        return Some(("menu-surface", Some(i32::from(*n))));
    }
    if let Some((.., event)) = WB_FILE_ITEMS.iter().find(|(item, ..)| *item == id) {
        return Some((event, None));
    }
    if let Some((.., n)) = WB_CYCLE_ITEMS.iter().find(|(item, ..)| *item == id) {
        return Some(("menu-tab-cycle", Some(*n)));
    }
    WB_INDEX_ITEMS
        .iter()
        .find(|(item, ..)| *item == id)
        .map(|(.., n)| ("menu-tab-index", Some(*n)))
}

/// Which set a `set_*_menu` call is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Set {
    Flow,
    Workbench,
}

/// Put the flow items into the app menu, or take them out. Enabling also
/// removes the workbench items. Runs on the main thread, where AppKit wants
/// its menus touched.
#[tauri::command]
pub fn set_flow_menu<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<(), String> {
    set_menu(app, Set::Flow, enabled)
}

/// Put the workbench items into the app menu, or take them out. Enabling
/// also removes the flow items.
#[tauri::command]
pub fn set_workbench_menu<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<(), String> {
    set_menu(app, Set::Workbench, enabled)
}

fn set_menu<R: Runtime>(app: AppHandle<R>, set: Set, enabled: bool) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(e) = apply(&handle, set, enabled) {
            tracing::warn!(?set, enabled, error = %e, "shell menu not updated");
        }
    })
    .map_err(|e| e.to_string())
}

fn apply<R: Runtime>(app: &AppHandle<R>, set: Set, enabled: bool) -> tauri::Result<()> {
    let Some(menu) = app.menu() else { return Ok(()) };
    let top = menu.items()?;
    // The stock macOS menu: the app submenu, then File (setup rebuilt it as
    // Close ⌘W · Print… ⌘P), then Edit.
    let file = match top.get(1) {
        Some(MenuItemKind::Submenu(file)) => Some(file.clone()),
        _ => None,
    };
    let other = match set {
        Set::Flow => Set::Workbench,
        Set::Workbench => Set::Flow,
    };
    if enabled {
        remove_set(app, other, file.as_ref())?;
        match set {
            Set::Flow => {
                if let Some(file) = &file {
                    if file.get(NEW_SESSION_ID).is_none() {
                        let item = MenuItemBuilder::with_id(NEW_SESSION_ID, "New Session")
                            .accelerator("CmdOrCtrl+N")
                            .build(app)?;
                        file.insert(&item, 0)?;
                    }
                }
                if menu.get(TOOLS_MENU_ID).is_none() {
                    let tools = tools_submenu(app)?;
                    menu.insert(&tools, 3.min(menu.items()?.len()))?;
                }
            }
            Set::Workbench => {
                if let Some(file) = &file {
                    // New Tab · Reopen Closed Tab · ─ · (Close ⌘W) · Close
                    // Window · ─ · Print…: the new items lead the stock
                    // Close, and Close Window follows it.
                    let mut at = 0;
                    for (id, label, accelerator, _) in WB_FILE_ITEMS.iter().take(2) {
                        if file.get(*id).is_none() {
                            let item = MenuItemBuilder::with_id(*id, *label).accelerator(*accelerator).build(app)?;
                            file.insert(&item, at)?;
                        }
                        at += 1;
                    }
                    if file.get(WB_CLOSE_WINDOW_ID).is_none() {
                        let (id, label, accelerator, _) = WB_FILE_ITEMS[2];
                        let item = MenuItemBuilder::with_id(id, label).accelerator(accelerator).build(app)?;
                        // Right after the stock Close, or after the new items
                        // when setup left no Close behind.
                        let close_at = file
                            .items()?
                            .iter()
                            .position(|item| item.id().as_ref() == "close_tab")
                            .map(|i| i + 1)
                            .unwrap_or(at);
                        file.insert(&item, close_at)?;
                    }
                }
                if menu.get(WB_TABS_MENU_ID).is_none() {
                    let tabs = tabs_submenu(app)?;
                    menu.insert(&tabs, 3.min(menu.items()?.len()))?;
                }
            }
        }
    } else {
        remove_set(app, set, file.as_ref())?;
    }
    Ok(())
}

fn remove_set<R: Runtime>(
    app: &AppHandle<R>,
    set: Set,
    file: Option<&Submenu<R>>,
) -> tauri::Result<()> {
    let Some(menu) = app.menu() else { return Ok(()) };
    let (file_ids, submenu_id): (&[&str], &str) = match set {
        Set::Flow => (&[NEW_SESSION_ID], TOOLS_MENU_ID),
        Set::Workbench => (&[WB_NEW_TAB_ID, WB_REOPEN_TAB_ID, WB_CLOSE_WINDOW_ID], WB_TABS_MENU_ID),
    };
    if let Some(file) = file {
        for id in file_ids {
            if let Some(item) = file.get(*id) {
                file.remove(&item)?;
            }
        }
    }
    if let Some(MenuItemKind::Submenu(submenu)) = menu.get(submenu_id) {
        menu.remove(&submenu)?;
    }
    Ok(())
}

fn tools_submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let mut builder = SubmenuBuilder::with_id(app, TOOLS_MENU_ID, "Tools");
    for (id, label, accelerator, _) in TOOL_ITEMS {
        builder = builder.item(&MenuItemBuilder::with_id(id, label).accelerator(accelerator).build(app)?);
    }
    builder.build()
}

fn tabs_submenu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Submenu<R>> {
    let mut builder = SubmenuBuilder::with_id(app, WB_TABS_MENU_ID, "Tabs");
    for (id, label, accelerator, _) in WB_CYCLE_ITEMS {
        builder = builder.item(&MenuItemBuilder::with_id(id, label).accelerator(accelerator).build(app)?);
    }
    builder = builder.item(&PredefinedMenuItem::separator(app)?);
    for (id, label, accelerator, _) in WB_INDEX_ITEMS {
        builder = builder.item(&MenuItemBuilder::with_id(id, label).accelerator(accelerator).build(app)?);
    }
    builder.build()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn flow_ids() -> Vec<&'static str> {
        let mut ids: Vec<&str> = TOOL_ITEMS.iter().map(|(id, ..)| *id).collect();
        ids.extend([NEW_SESSION_ID, TOOLS_MENU_ID]);
        ids
    }

    fn workbench_ids() -> Vec<&'static str> {
        let mut ids: Vec<&str> = WB_FILE_ITEMS.iter().map(|(id, ..)| *id).collect();
        ids.extend(WB_CYCLE_ITEMS.iter().map(|(id, ..)| *id));
        ids.extend(WB_INDEX_ITEMS.iter().map(|(id, ..)| *id));
        ids.push(WB_TABS_MENU_ID);
        ids
    }

    #[test]
    fn new_session_and_the_four_tools_map_to_their_events() {
        assert_eq!(event_for(NEW_SESSION_ID), Some(("menu-new-session", None)));
        for (id, _, _, n) in TOOL_ITEMS {
            assert_eq!(event_for(id), Some(("menu-surface", Some(i32::from(n)))));
        }
        // Every other menu id is someone else's.
        for id in ["close_tab", "print_page", "check_updates", "quit", "flow_tool_5", "wb_tab_9", "wb_tab_0", ""] {
            assert_eq!(event_for(id), None, "{id}");
        }
        // The submenus themselves are not items.
        assert_eq!(event_for(TOOLS_MENU_ID), None);
        assert_eq!(event_for(WB_TABS_MENU_ID), None);
    }

    #[test]
    fn the_tools_are_command_one_through_four_in_board_order() {
        let accelerators: Vec<_> = TOOL_ITEMS.iter().map(|(_, _, a, _)| *a).collect();
        assert_eq!(accelerators, ["CmdOrCtrl+1", "CmdOrCtrl+2", "CmdOrCtrl+3", "CmdOrCtrl+4"]);
        let labels: Vec<_> = TOOL_ITEMS.iter().map(|(_, l, _, _)| *l).collect();
        assert_eq!(labels, ["Browser", "Prompt Drafter", "Code Review", "Localhost"]);
        let numbers: Vec<_> = TOOL_ITEMS.iter().map(|(.., n)| *n).collect();
        assert_eq!(numbers, [1, 2, 3, 4]);
    }

    #[test]
    fn every_workbench_item_maps_to_its_event_and_payload() {
        assert_eq!(event_for(WB_NEW_TAB_ID), Some(("menu-new-tab", None)));
        assert_eq!(event_for(WB_REOPEN_TAB_ID), Some(("menu-reopen-tab", None)));
        assert_eq!(event_for(WB_CLOSE_WINDOW_ID), Some(("menu-close-window", None)));
        assert_eq!(event_for(WB_PREV_TAB_ID), Some(("menu-tab-cycle", Some(-1))));
        assert_eq!(event_for(WB_NEXT_TAB_ID), Some(("menu-tab-cycle", Some(1))));
        for (i, (id, ..)) in WB_INDEX_ITEMS.iter().take(8).enumerate() {
            assert_eq!(event_for(id), Some(("menu-tab-index", Some(i as i32))), "{id}");
        }
        assert_eq!(event_for(WB_LAST_TAB_ID), Some(("menu-tab-index", Some(-1))));
    }

    #[test]
    fn the_workbench_accelerators_are_in_order() {
        let file: Vec<_> = WB_FILE_ITEMS.iter().map(|(_, _, a, _)| *a).collect();
        assert_eq!(file, ["CmdOrCtrl+T", "CmdOrCtrl+Shift+T", "CmdOrCtrl+Shift+W"]);
        let cycle: Vec<_> = WB_CYCLE_ITEMS.iter().map(|(_, _, a, _)| *a).collect();
        assert_eq!(cycle, ["CmdOrCtrl+Shift+[", "CmdOrCtrl+Shift+]"]);
        let index: Vec<_> = WB_INDEX_ITEMS.iter().map(|(_, _, a, _)| *a).collect();
        let expected: Vec<String> = (1..=9).map(|n| format!("CmdOrCtrl+{n}")).collect();
        assert_eq!(index, expected);
        let labels: Vec<_> = WB_INDEX_ITEMS.iter().map(|(_, l, _, _)| *l).collect();
        assert_eq!(labels, ["Tab 1", "Tab 2", "Tab 3", "Tab 4", "Tab 5", "Tab 6", "Tab 7", "Tab 8", "Last Tab"]);
        // ⌘W is lib.rs's "Close" item, never one of ours: a second ⌘W
        // would shadow it.
        for (_, _, a, _) in WB_FILE_ITEMS {
            assert_ne!(a, "CmdOrCtrl+W");
        }
    }

    #[test]
    fn ids_never_collide_within_or_across_the_sets() {
        let flow = flow_ids();
        let workbench = workbench_ids();
        assert_eq!(flow.iter().collect::<HashSet<_>>().len(), flow.len());
        assert_eq!(workbench.iter().collect::<HashSet<_>>().len(), workbench.len());
        let all: HashSet<_> = flow.iter().chain(workbench.iter()).collect();
        assert_eq!(all.len(), flow.len() + workbench.len());
        // Each set wears its own prefix, so a glance at a menu id says whose it is.
        assert!(flow.iter().all(|id| id.starts_with("flow_")));
        assert!(workbench.iter().all(|id| id.starts_with("wb_")));
        // And neither borrows one of lib.rs's setup ids.
        for id in ["close_tab", "print_page", "check_updates", "view_readme", "send_feedback", "show_tutorial", "remove_hook", "quit"] {
            assert!(!flow.contains(&id) && !workbench.contains(&id), "{id}");
        }
    }

    #[test]
    fn the_sets_share_accelerators_which_is_why_they_are_exclusive() {
        // ⌘1–⌘4 are a flow Tool and a workbench tab: the same chord cannot be
        // two menu items at once, so `apply` removes one set before adding
        // the other.
        let flow: HashSet<_> = TOOL_ITEMS.iter().map(|(_, _, a, _)| *a).collect();
        let workbench: HashSet<_> = WB_INDEX_ITEMS.iter().map(|(_, _, a, _)| *a).collect();
        let shared: Vec<_> = flow.intersection(&workbench).collect();
        assert_eq!(shared.len(), 4);
    }

    #[test]
    fn every_workbench_id_answers_and_every_flow_id_answers() {
        for id in workbench_ids().into_iter().filter(|id| *id != WB_TABS_MENU_ID) {
            assert!(event_for(id).is_some(), "{id}");
        }
        for id in flow_ids().into_iter().filter(|id| *id != TOOLS_MENU_ID) {
            assert!(event_for(id).is_some(), "{id}");
        }
    }
}
