// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Yusuf Al-Bazian
//
// The browser's new-tab page: one omnibox with two verbs (Browse ⏎, you
// drive; Agent search ⌥⏎, the page agent finds the page and answers in Page
// chat), a live strip (dev servers, pages the agent is working on, research
// missions), then two columns: Pick back up (this workspace's pages, task
// lists, recently closed) and Reading, by subject. No thumbnail grid.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, Brain, Folder, Globe, History, ListTodo, Sparkles, Target } from "lucide-react";
import { candidateTabs, type CandidateTab } from "../lib/doorRecents";
import { buildBrowserHome, type BrowserHomeFeed } from "../lib/browserHome";
import { denylistCount, hostOf, newTabKicker, pickBackUp, readingBySubject, shortAge, type ClosedPage } from "../lib/browserNewTab";
import type { DevServerScan, RunningServer } from "../types";
import { Spinner } from "./Spinner";
import type { TilePage } from "./BrowserTileStage";
import "./BrowserHomePage.css";

const empty: BrowserHomeFeed = { recent: [], frequent: [], tasks: [], missions: [] };

export interface BrowserHomePageProps {
  /** The new tab this page is drawn in. */
  page: TilePage;
  /** Every page of the workspace, in strip order. */
  tabs: TilePage[];
  /** Tabs (by id) the agent is acting on now. */
  acting?: ReadonlySet<string>;
  /** Pages closed in this workspace, newest first. */
  closed?: readonly ClosedPage[];
  /** ⏎: open the text in this tab, as an address or a search. */
  onBrowse: (text: string) => void;
  /** ⌥⏎: the page agent searches, opens the best page and answers in Page chat. */
  onAgentSearch: (text: string) => void;
  /** Open an address (an open tab with it is brought forward). */
  onOpen: (url: string) => void;
  onSelectTab: (id: string) => void;
  onMission: (id: string) => void;
  /** Opens Memory; the page's Memory links are plain text without it. */
  onOpenMemory?: () => void;
  /** Fixed for tests; defaults to the wall clock. */
  now?: number;
}

export default function BrowserHomePage(props: BrowserHomePageProps) {
  const { page, tabs, acting, closed = [], onOpenMemory } = props;
  const [feed, setFeed] = useState(empty), [candidates, setCandidates] = useState<CandidateTab[]>([]);
  const [servers, setServers] = useState<RunningServer[]>([]), [denied, setDenied] = useState(0);
  const [error, setError] = useState(""), [text, setText] = useState(""), [closedOpen, setClosedOpen] = useState(false);
  // Until the history read settles the columns say nothing, rather than
  // flashing their empty-state lines at someone who has history.
  const [loaded, setLoaded] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const now = props.now ?? Date.now();
  useEffect(() => {
    let current = true;
    void Promise.all([invoke<BrowserHomeFeed>("browser_home_feed", { limit: 24 }), candidateTabs(invoke, localStorage)])
      .then(([next, found]) => { if (current) { setFeed(buildBrowserHome(next ?? empty, found, 24)); setCandidates(found); } })
      .catch(() => { if (current) { setError("Browsing history could not be loaded."); setFeed(buildBrowserHome(empty, [])); } })
      .finally(() => { if (current) setLoaded(true); });
    // One sweep, not a poll: the strip says what is up as the page opens.
    void invoke<DevServerScan>("dev_servers_scan").then((scan) => { if (current) setServers(scan?.running ?? []); }).catch(() => {});
    void invoke<{ denylist: string }>("shots_get_policy").then((policy) => { if (current) setDenied(denylistCount(policy?.denylist)); }).catch(() => {});
    return () => { current = false; };
  }, []);

  const webTabs = tabs.filter((tab) => /^https?:\/\//i.test(tab.url));
  const openUrls = new Set(webTabs.map((tab) => tab.url));
  const picks = pickBackUp({ tabs, currentId: page.id, recent: feed.recent, tasks: feed.tasks });
  const subjects = readingBySubject({ recent: feed.recent, candidates, openUrls, now });
  const actingTabs = tabs.filter((tab) => acting?.has(tab.id));
  const live = servers.length + actingTabs.length + feed.missions.length > 0;
  const submit = (agent: boolean) => {
    const value = text.trim();
    if (!value) { input.current?.focus(); return; }
    if (agent) props.onAgentSearch(value); else props.onBrowse(value);
  };
  const memoryLink = (label: string) => onOpenMemory
    ? <button type="button" className="rb-nt-link" onClick={onOpenMemory}>{label}</button>
    : <span>{label}</span>;

  return <div className="rb-home" data-newtab data-loaded={loaded || undefined}>
    <div className="rb-nt-column">
      <header className="rb-nt-head">
        <span className="rb-nt-kicker">{newTabKicker(new Date(now), webTabs.length)}</span>
        <h1>A place to pick up{" "}<br/>where you left off.</h1>
      </header>
      <form className="rb-nt-omnibox" role="search" aria-label="Browse or search" onSubmit={(e) => { e.preventDefault(); submit(false); }}>
        <div className="rb-nt-field"><Globe size={18} aria-hidden/>
          <input ref={input} aria-label="Address, or something to find" placeholder="Address, or something to find…" value={text}
            spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && e.altKey) { e.preventDefault(); submit(true); } }}/>
        </div>
        <div className="rb-nt-verbs">
          <button type="submit" className="rb-nt-verb" data-primary title="Open the address or search result yourself"><Globe size={12} aria-hidden/>Browse<kbd>⏎</kbd></button>
          <button type="button" className="rb-nt-verb" title="The page agent opens the best tab, answers in Page chat and offers a couple more routes" onClick={() => submit(true)}><Sparkles size={12} aria-hidden/>Agent search<kbd>⌥⏎</kbd></button>
          <span className="rb-nt-hint">Agent search opens the right tab and answers in Page chat</span>
          <button type="submit" className="rb-nt-go" aria-label="Go"><ArrowRight size={16} aria-hidden/></button>
        </div>
      </form>
      {error && <p className="rb-nt-note" role="status">{error}</p>}
      {live && <div className="rb-nt-live" aria-label="Live now">
        {servers.map((server) => <button key={`srv:${server.pid}:${server.port}`} type="button" className="rb-nt-chip" onClick={() => props.onOpen(server.url)} title={server.url}>
          <i className="rb-nt-dot" data-tone="up" aria-hidden/>localhost:{server.port}<span>{[server.projectName, server.stack].filter(Boolean).join(" · ")}</span></button>)}
        {actingTabs.map((tab) => <button key={`act:${tab.id}`} type="button" className="rb-nt-chip" onClick={() => props.onSelectTab(tab.id)} title={tab.url}>
          <Spinner size={10}/>{tab.title || hostOf(tab.url)}<span>agent working</span></button>)}
        {feed.missions.map((mission) => <button key={`mission:${mission.missionId}`} type="button" className="rb-nt-chip" onClick={() => props.onMission(mission.missionId)}>
          <Target size={13} aria-hidden/>{mission.title}<span>research</span></button>)}
      </div>}
      <div className="rb-nt-columns">
        <section className="rb-nt-section" aria-label="Pick back up">
          <SectionHead title="Pick back up" aside={<span>this workspace</span>}/>
          {picks.map((row) => row.kind === "tab"
            ? <Row key={row.key} icon={<PageIcon favicon={row.favicon}/>} title={row.title} detail={row.detail} age={shortAge(row.at, now)} onClick={() => props.onSelectTab(row.tabId)} hint={row.url}/>
            : <Row key={row.key} icon={<ListTodo size={13} aria-hidden/>} title={row.title} detail={row.detail} onClick={() => props.onOpen(row.url)} hint={row.url}/>)}
          {closed.length > 0 && <Row icon={<History size={13} aria-hidden/>} muted title={`Recently closed · ${closed.length}`} expanded={closedOpen} onClick={() => setClosedOpen((v) => !v)}/>}
          {closedOpen && closed.map((item) => <Row key={`closed:${item.url}`} nested icon={<PageIcon/>} title={item.title || hostOf(item.url)} detail={hostOf(item.url)} age={shortAge(item.at, now)} onClick={() => props.onOpen(item.url)} hint={item.url}/>)}
          {loaded && !picks.length && !closed.length && <p className="rb-nt-empty">Pages you open here stay in reach while you work.</p>}
        </section>
        <section className="rb-nt-section" aria-label="Reading, by subject">
          <SectionHead title="Reading, by subject" aside={onOpenMemory ? <button type="button" className="rb-nt-link" onClick={onOpenMemory}>Ask Memory</button> : null}/>
          {subjects.map((group, i) => <div key={`${group.kind}:${group.name}`} className="rb-nt-subject" data-first={i === 0 || undefined}>
            <div className="rb-nt-subject-head">{group.kind === "mission" ? <Target size={12} aria-hidden/> : <Folder size={12} aria-hidden/>}<strong>{group.name}</strong>
              <span>· {group.pages.length} {group.pages.length === 1 ? "page" : "pages"}{group.span ? ` · ${group.span}` : ""}</span></div>
            {group.pages.map((item) => <Row key={item.url} icon={<PageIcon/>} title={item.title} age={shortAge(item.at, now)} onClick={() => props.onOpen(item.url)} hint={item.url}/>)}
          </div>)}
          {loaded && !subjects.length && <p className="rb-nt-empty">Pages you read are gathered here by subject.</p>}
        </section>
      </div>
      <footer className="rb-nt-foot"><Brain size={12} aria-hidden/><span>Every page you read is filed in Memory, by subject, never by tab.</span>{memoryLink("What did I read on…")}
        <span className="rb-nt-spacer"/>{memoryLink(`Never capture · ${denied} ${denied === 1 ? "domain" : "domains"}`)}</footer>
    </div>
  </div>;
}

function SectionHead({ title, aside }: { title: string; aside?: ReactNode }) {
  return <div className="rb-nt-section-head"><h2>{title}</h2>{aside}</div>;
}

function PageIcon({ favicon }: { favicon?: string }) {
  const [failed, setFailed] = useState(false);
  return favicon && !failed
    ? <img className="rb-favicon" src={favicon} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)}/>
    : <Globe size={13} aria-hidden/>;
}

function Row({ icon, title, detail, age, hint, muted, nested, expanded, onClick }: {
  icon: ReactNode; title: string; detail?: string; age?: string; hint?: string; muted?: boolean; nested?: boolean; expanded?: boolean; onClick: () => void;
}) {
  return <button type="button" className="rb-nt-row" data-muted={muted || undefined} data-nested={nested || undefined} aria-expanded={expanded} title={hint} onClick={onClick}>
    <span className="rb-nt-row-icon">{icon}</span>
    <span className="rb-nt-row-title">{title}{detail && <span> · {detail}</span>}</span>
    {age && <span className="rb-nt-row-age">{age}</span>}
  </button>;
}
