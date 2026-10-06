// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Globe2, ListTodo, Target } from "lucide-react";
import { candidateTabs } from "../lib/doorRecents";
import { buildBrowserHome, type BrowserHomeFeed, type HomePage } from "../lib/browserHome";
import type { TilePage } from "./BrowserTileStage";
import "./BrowserHomePage.css";
const empty: BrowserHomeFeed = { recent: [], frequent: [], tasks: [], missions: [] };
export default function BrowserHomePage({ tabs, onOpen, onMission }: { tabs: TilePage[]; onOpen: (url: string) => void; onMission: (id: string) => void }) {
  const [feed, setFeed] = useState(empty), [error, setError] = useState(""), [paths, setPaths] = useState<Map<string, string>>(() => new Map());
  useEffect(() => {
    let current = true;
    void Promise.all([invoke<BrowserHomeFeed>("browser_home_feed", { limit: 12 }), candidateTabs(invoke, localStorage)]).then(([feed, candidates]) => { if (current) setFeed(buildBrowserHome(feed, [...tabs, ...candidates])); }).catch(() => { if (current) { setError("Browsing history could not be loaded."); setFeed(buildBrowserHome(empty, tabs)); } });
    void invoke<{ key: string; path: string }[]>("shots_list").then(shots => { if (current) setPaths(new Map(shots.map(shot => [shot.key, shot.path]))); }).catch(() => {});
    return () => { current = false; };
  }, []);
  const section = (title: string, pages: HomePage[]) => <section aria-label={title}><h2>{title}</h2>{pages.length ? <div className="rb-home-grid">{pages.map(page => <HomeTile key={page.url} page={page} path={page.shotKey ? paths.get(page.shotKey) : undefined} onOpen={() => onOpen(page.url)}/>)}</div> : <p className="rb-home-empty">{title === "Recent" ? "Pages you visit will appear here." : "Your frequently visited sites will appear here."}</p>}</section>;
  return <div className="rb-home"><header><span>Redline</span><h1>A place to pick up where you left off.</h1><p>Search or enter an address above.</p></header>{error && <p role="status">{error}</p>}
    {!!(feed.tasks.length || feed.missions.length) && <section aria-label="Pick back up"><h2>Pick back up</h2><div className="rb-home-grid">{feed.tasks.map(page => <button key={page.url} className="rb-home-tile rb-home-task" onClick={() => onOpen(page.url)}><ListTodo size={18}/><strong>{page.title}</strong><span>{page.count} unfinished {page.count === 1 ? "task" : "tasks"}</span></button>)}{feed.missions.map(mission => <button key={mission.missionId} className="rb-home-tile rb-home-task" onClick={() => onMission(mission.missionId)}><Target size={18}/><strong>{mission.title}</strong><span>Research mission</span></button>)}</div></section>}
    {section("Recent", feed.recent)}{section("Frequent", feed.frequent)}
  </div>;
}
function HomeTile({ page, path, onOpen }: { page: HomePage; path?: string; onOpen: () => void }) {
  const node = useRef<HTMLButtonElement>(null), [image, setImage] = useState("");
  useEffect(() => {
    if (!path || !node.current) return;
    let current = true;
    const load = () => { void invoke<{ data: string }>("read_file_base64", { path }).then(file => { if (current && file.data) setImage(`data:image/png;base64,${file.data}`); }).catch(() => {}); };
    if (typeof IntersectionObserver === "undefined") { load(); return () => { current = false; }; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { observer.disconnect(); load(); } }); observer.observe(node.current);
    return () => { current = false; observer.disconnect(); };
  }, [path]);
  return <button ref={node} className="rb-home-tile" onClick={onOpen} title={page.url}><div className="rb-home-shot">{image ? <img src={image} alt="" loading="lazy"/> : <Globe2 size={22}/>}</div><strong>{page.title}</strong><span>{new URL(page.url).hostname}{page.browseId ? " · Open tab" : ""}</span></button>;
}
