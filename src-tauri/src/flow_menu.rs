// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//! The flow shell's menu accelerators: ⌘N for a new session and ⌘1–⌘4 for
//! the Tools (Browser, Prompt Drafter, Code Review, Localhost), as native
//! menu items. A menu key equivalent fires whatever has focus — an embedded
//! browser page included, where no listener of the app's own document can
//! hear the keyboard at all — the same reason ⌘W is a menu item (lib.rs).
//!
//! The shell is a frontend choice (lib/shellFlag, read once per page load),
//! so the menu learns it from the frontend: the flow shell calls
//! `set_flow_menu(true)` as it mounts, and Settings → Shell calls
//! `set_flow_menu(false)` before reloading into classic. A classic launch
//! never calls it, so the classic menu — and ⌘1–4, left to the page — is
//! exactly what it was. Idempotent both ways: a reload, or React running an
//! effect twice, finds the items already in (or already out of) place.

use tauri::menu::{MenuItemBuilder, MenuItemKind, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Runtime};

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

/// What a click on one of these items tells the frontend: the event, and
/// for a tool its ⌘ number. None for every other menu id.
pub fn event_for(id: &str) -> Option<(&'static str, Option<u8>)> {
    if id == NEW_SESSION_ID {
        return Some(("menu-new-session", None));
    }
    TOOL_ITEMS
        .iter()
        .find(|(item, ..)| *item == id)
        .map(|(.., n)| ("menu-surface", Some(*n)))
}

/// Put the flow items into the app menu, or take them out. Runs on the main
/// thread, where AppKit wants its menus touched.
#[tauri::command]
pub fn set_flow_menu<R: Runtime>(app: AppHandle<R>, enabled: bool) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(e) = apply(&handle, enabled) {
            tracing::warn!(enabled, error = %e, "flow menu not updated");
        }
    })
    .map_err(|e| e.to_string())
}

fn apply<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> tauri::Result<()> {
    let Some(menu) = app.menu() else { return Ok(()) };
    let top = menu.items()?;
    // The stock macOS menu: the app submenu, then File (setup rebuilt it as
    // Close ⌘W · Print… ⌘P), then Edit.
    let file = match top.get(1) {
        Some(MenuItemKind::Submenu(file)) => Some(file.clone()),
        _ => None,
    };
    if enabled {
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
            menu.insert(&tools, 3.min(top.len()))?;
        }
    } else {
        if let Some(file) = &file {
            if let Some(item) = file.get(NEW_SESSION_ID) {
                file.remove(&item)?;
            }
        }
        if let Some(MenuItemKind::Submenu(tools)) = menu.get(TOOLS_MENU_ID) {
            menu.remove(&tools)?;
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_session_and_the_four_tools_map_to_their_events() {
        assert_eq!(event_for(NEW_SESSION_ID), Some(("menu-new-session", None)));
        for (id, _, _, n) in TOOL_ITEMS {
            assert_eq!(event_for(id), Some(("menu-surface", Some(n))));
        }
        // Every other menu id is someone else's.
        for id in ["close_tab", "print_page", "check_updates", "quit", "flow_tool_5", ""] {
            assert_eq!(event_for(id), None, "{id}");
        }
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
    fn ids_never_collide_with_each_other() {
        let mut ids: Vec<&str> = TOOL_ITEMS.iter().map(|(id, ..)| *id).collect();
        ids.extend([NEW_SESSION_ID, TOOLS_MENU_ID]);
        let unique: std::collections::HashSet<_> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len());
    }
}
