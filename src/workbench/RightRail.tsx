// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The right rail's chrome (W4): the 34px tab strip over whichever tab body
// App hands it, and — collapsed — the 40px edge strip of the same tabs as
// icons, so every one of them (the mic included) stays one click away. Pure
// and presentational: App decides the tabs (`rail.ts`), the active one, the
// counts, and what each body is; only the active tab's body is ever mounted,
// so a tab that is not shown cannot poll.
//
// Lazy, with its stylesheet: nothing here is on the boot path.

import { dropListener } from "../lib/dropListener";
import { memo, useEffect, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  FolderTree,
  Globe,
  House,
  PanelLeftOpen,
  GitCompare,
  Maximize2,
  MessagesSquare,
  Mic,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  type LucideIcon,
} from "lucide-react";

import { Spinner } from "../components/Spinner";
import { setVoiceAway, useVoiceAway, type AwayState } from "../audio/voiceAway";
import { RAIL_TAB_LABEL, type RailTab } from "./rail";
import "./rail.css";

const RAIL_ICON: Record<RailTab, LucideIcon> = {
  discussion: MessagesSquare,
  talk: Mic,
  files: FolderTree,
  changes: GitCompare,
};

/** A voice turn left running when Talk was put away (`voiceAway`), for
 *  this pane's conversation: working while it runs, then waiting once its
 *  reply has landed. The Talk tab wears it — the Discuss pill's old job. */
function useTalkAway(talkKey: string | null | undefined): AwayState | null {
  const tracked = useVoiceAway();
  const awayKey = tracked?.state === "thinking" ? tracked.key : null;
  useEffect(() => {
    if (!awayKey) return;
    let alive = true;
    const ended = () => {
      if (alive) setVoiceAway({ key: awayKey, state: "waiting" });
    };
    // A failure persists nothing to come back to, so it clears the mark.
    const gone = () => {
      if (alive) setVoiceAway(null);
    };
    const subs = [
      listen<{ sessionId: string }>("voice-done", (e) => e.payload.sessionId === awayKey && ended()),
      listen<{ sessionId: string; text: string }>("voice-interrupted", (e) => e.payload.sessionId === awayKey && (e.payload.text ? ended() : gone())),
      listen<{ sessionId: string }>("voice-error", (e) => e.payload.sessionId === awayKey && gone()),
      listen<{ sessionId: string }>("voice-exit", (e) => e.payload.sessionId === awayKey && gone()),
    ];
    // One that ended while nothing was watching is caught by asking.
    void invoke<{ inFlight: boolean }>("voice_session_status", { sessionId: awayKey })
      .then((st) => {
        if (!st.inFlight) ended();
      })
      .catch(() => {});
    return () => {
      alive = false;
      for (const p of subs) void p.then(dropListener);
    };
  }, [awayKey]);
  return tracked && talkKey && tracked.key === talkKey ? tracked.state : null;
}

function AwayMark({ state }: { state: AwayState | null }) {
  if (state === "thinking") return <Spinner size={10} />;
  if (state === "waiting") return <span className="rl-rail-away rl-rail-pulse" aria-label="a reply is waiting" />;
  return null;
}

export interface RailBadges {
  /** A number beside the tab's name. */
  counts?: Partial<Record<RailTab, number>>;
  /** Tabs with something waiting on the user: the count wears amber. */
  attention?: Partial<Record<RailTab, boolean>>;
  /** The conversation Talk holds here (its voice key), so a turn left
   *  running in it shows on the Talk tab. */
  talkKey?: string | null;
}

export interface RightRailProps extends RailBadges {
  tabs: readonly RailTab[];
  active: RailTab;
  onSelect: (tab: RailTab) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** ◨: fold the rail to its edge strip (⌘⌥B). */
  onCollapse: () => void;
  /** The active tab's body. */
  children: ReactNode;
}

function Count({ tab, counts, attention }: { tab: RailTab } & RailBadges) {
  const n = counts?.[tab];
  if (!n) return null;
  return (
    <span className="rl-rail-count" data-attention={attention?.[tab] ? "" : undefined}>
      {n > 99 ? "99+" : n}
    </span>
  );
}

function RightRailBase({ tabs, active, onSelect, counts, attention, talkKey, fullscreen, onToggleFullscreen, onCollapse, children }: RightRailProps) {
  const away = useTalkAway(active === "talk" ? null : talkKey);
  return (
    <div className="rl-rail" data-rail-tab={active}>
      <div className="rl-rail-strip" role="tablist" aria-label="Rail" data-tour="rail">
        {tabs.map((tab) => {
          const Icon = RAIL_ICON[tab];
          const on = tab === active;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={on}
              data-rail-tab={tab}
              className="rl-rail-tab"
              title={tab === "talk" ? "Talk (⌘J)" : RAIL_TAB_LABEL[tab]}
              onClick={() => onSelect(tab)}
            >
              <Icon size={16} aria-hidden />
              <span className="rl-rail-tab-label">{RAIL_TAB_LABEL[tab]}</span>
              <Count tab={tab} counts={counts} attention={attention} />
              {tab === "talk" && <AwayMark state={away} />}
            </button>
          );
        })}
        <span className="rl-rail-spacer" />
        <button
          type="button"
          className="rl-rail-icon"
          title={fullscreen ? "Restore the rail" : "Fill the window with the rail"}
          aria-label={fullscreen ? "Restore the rail" : "Fill the window with the rail"}
          onClick={onToggleFullscreen}
        >
          {fullscreen ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}
        </button>
        <button type="button" className="rl-rail-icon" title="Hide the rail (⌘⌥B)" aria-label="Hide the rail" onClick={onCollapse}>
          <PanelRightClose size={16} aria-hidden />
        </button>
      </div>
      <div className="rl-rail-body" role="tabpanel" aria-label={RAIL_TAB_LABEL[active]}>
        {children}
      </div>
    </div>
  );
}

export const RightRail = memo(RightRailBase);

export interface RailEdgeProps extends RailBadges {
  tabs: readonly RailTab[];
  /** Open the rail on this tab. */
  onOpen: (tab: RailTab) => void;
  /** ◨: open the rail on the tab it remembers (⌘⌥B). */
  onExpand: () => void;
}

/** The collapsed rail: the tabs as 16px icons down a 40px strip, the
 *  attention count riding the icon, and the way back open at the foot. */
function RailEdgeBase({ tabs, onOpen, onExpand, counts, attention, talkKey }: RailEdgeProps) {
  const away = useTalkAway(talkKey);
  return (
    <div className="rl-rail-edge" aria-label="Rail">
      {tabs.map((tab) => {
        const Icon = RAIL_ICON[tab];
        const n = counts?.[tab];
        return (
          <button
            key={tab}
            type="button"
            className="rl-rail-edge-btn"
            data-rail-tab={tab}
            title={n ? `${RAIL_TAB_LABEL[tab]} · ${n}` : tab === "talk" ? "Talk (⌘J)" : RAIL_TAB_LABEL[tab]}
            aria-label={RAIL_TAB_LABEL[tab]}
            onClick={() => onOpen(tab)}
          >
            <Icon size={16} aria-hidden />
            {tab === "talk" && away && (
              <span className="rl-rail-edge-away">
                <AwayMark state={away} />
              </span>
            )}
            {!!n && (
              <span className="rl-rail-edge-count" data-attention={attention?.[tab] ? "" : undefined}>
                {n > 9 ? "9+" : n}
              </span>
            )}
          </button>
        );
      })}
      <span className="rl-rail-spacer" />
      <button type="button" className="rl-rail-edge-btn" title="Show the rail (⌘⌥B)" aria-label="Show the rail" onClick={onExpand}>
        <PanelRightOpen size={16} aria-hidden />
      </button>
    </div>
  );
}

export const RailEdge = memo(RailEdgeBase);

export type EdgeSessionTone = "needs" | "review" | "done" | "idle";

export interface SidebarEdgeProps {
  /** Which Place is current, if one is. */
  place: "home" | "servers" | null;
  sessions: readonly { id: string; title: string; tone: EdgeSessionTone; active: boolean }[];
  onPlace: (place: "home" | "servers") => void;
  onSession: (id: string) => void;
  /** ◧: the full sidebar (⌘B). */
  onExpand: () => void;
}

/** The collapsed sidebar's icon pose (D18): Home and Localhost, then each
 *  session as a status dot — amber pulsing when it needs you, amber in
 *  review, green when approved — and the way back open at the foot. */
function SidebarEdgeBase({ place, sessions, onPlace, onSession, onExpand }: SidebarEdgeProps) {
  return (
    <nav className="rl-side-edge" aria-label="Sidebar">
      <button type="button" className="rl-rail-edge-btn" data-current={place === "home" ? "" : undefined} title="Home" aria-label="Home" onClick={() => onPlace("home")}>
        <House size={16} aria-hidden />
      </button>
      <button type="button" className="rl-rail-edge-btn" data-current={place === "servers" ? "" : undefined} title="Localhost" aria-label="Localhost" onClick={() => onPlace("servers")}>
        <Globe size={16} aria-hidden />
      </button>
      {sessions.length > 0 && <span className="rl-side-edge-rule" aria-hidden />}
      <div className="rl-side-edge-list">
        {sessions.map((x) => (
          <button key={x.id} type="button" className="rl-rail-edge-btn" data-current={x.active ? "" : undefined} title={x.title} aria-label={x.title} onClick={() => onSession(x.id)}>
            <span className="rl-side-edge-dot" data-tone={x.tone} />
          </button>
        ))}
      </div>
      <span className="rl-rail-spacer" />
      <button type="button" className="rl-rail-edge-btn" title="Show the sidebar (⌘B)" aria-label="Show the sidebar" onClick={onExpand}>
        <PanelLeftOpen size={16} aria-hidden />
      </button>
    </nav>
  );
}

export const SidebarEdge = memo(SidebarEdgeBase);
