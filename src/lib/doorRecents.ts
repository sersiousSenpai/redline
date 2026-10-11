// SPDX-License-Identifier: Apache-2.0
// The Front Door's way BACK: recent plans, chats and browser tabs as pills.
// A door you return to should show you where you were, not suggest generic
// sentences — so the pills are the work itself, grouped by kind.
//
// Browser tabs are ranked by what they are FOR: research that bears on a plan
// still in review comes first. "Bears on" is judged two ways — an explicit link
// (a plan's Search-from-the-plan comment names its tab), and topic: a tab whose
// title, address or mission goal shares distinctive terms with an unresolved
// plan. Gaussian-splat tabs gathered under a "LiDAR for machine OS" mission
// belong next to the MachineOS LiDAR plan even though no one linked them.

import { BROWSER_HOME_URL } from "./browserTitle";

export type DoorRecentKind = "plan" | "chat" | "browse";

export interface DoorRecent {
  kind: DoorRecentKind;
  /** Session id, companion id, or browseId — whatever reopens it. */
  id: string;
  label: string;
  /** Full context for the tooltip. */
  detail: string;
  /** Browse only: reopens the page when its tab has since closed. */
  url?: string;
  /** Browse only: where the page lives, without "www." — its row's quiet
   *  second word. */
  host?: string;
  /** Browse only: an explicit research link — reopening it shows its answer. */
  research?: boolean;
}

/** A browser tab as the door sees it, after ranking. */
export interface DoorTab {
  browseId: string;
  url: string;
  title?: string;
  /** The plan this tab is research for, when one was found. */
  plan?: string;
  /** Why: "linked from the plan", or the shared terms. */
  why?: string;
  research?: boolean;
  /** The mission the tab was gathered under. */
  mission?: string;
}

/** A candidate tab before ranking. `context` is whatever surrounds it — a
 *  mission's title and goal — and counts for less than the tab's own words. */
export interface CandidateTab {
  browseId: string;
  url: string;
  title?: string;
  context?: string;
  /** Last known activity on the tab (its discussion, else its mission). */
  at?: number;
  /** The mission the tab was gathered under, by title. */
  mission?: string;
}

/** An unresolved plan's words, plus the research tabs it links explicitly. */
export interface PlanText {
  sessionId: string;
  title: string;
  /** The project the plan is for — the strongest statement of what it is. */
  project: string;
  /** The plan's headings: what it covers. */
  focus: string;
  /** When each revision arrived — the plan's working sessions. */
  times?: number[];
  text: string;
  research: { browseId: string; url?: string; query: string; createdAt: number }[];
}

// ---- Terms -----------------------------------------------------------------

const STOP = new Set(
  ("the and for with that this from into are was were will would should could " +
    "can not but have has had you your our their its it's they them then than " +
    "what when where which who how why all any each more most other some such " +
    "only own same very just also about over after before under again further " +
    "once here there both few nor too use used using via per out off one two new " +
    "now get got make made like need needs want plan plans build step steps phase " +
    "phases file files code test tests add adds added fix fixes change changes " +
    "http https www com org net html github official page home index google " +
    "research researching open source app apps desktop time real list text query " +
    "host event start line command repo repos api tool tools library free online " +
    "guide docs documentation overview introduction learn blog post news " +
    // Software and prose filler: every long plan says these, so sharing one
    // with a page means nothing.
    "current currently including include includes related domain content upload " +
    "uploads client clients user users server repository package packages document " +
    "documents based support supports simple flexible efficient robust comprehensive " +
    "high low precision model models data system systems work works working first " +
    "last next back way well even still since while within without across between " +
    "every many much part parts set sets run runs case cases type types value values " +
    "name names item items view views state status version versions update updates " +
    "create created read write show shows keep kept let lets see take takes given " +
    "implementation implement implemented creating components component search " +
    "official optimal allow allowing along future goal goals").split(" "),
);

/** Lowercased content words, plus each adjacent pair run together so
 *  "machine OS" meets "MachineOS". */
export function terms(text: string): Set<string> {
  const words = text
    .replace(/<!--[\s\S]*?-->/g, " ")
    // No camelCase splitting: "LiDAR" must stay "lidar" (not "li dar") and
    // "GitHub" must not become "git" — the pair-joining below is what lets
    // "machine OS" still meet "MachineOS".
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) out.add(w);
    const next = words[i + 1];
    if (next && w.length + next.length >= 5) {
      const joined = w + next;
      if (!STOP.has(joined)) out.add(joined);
    }
  }
  return out;
}

function urlWords(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")} ${decodeURIComponent(u.pathname)}`;
  } catch {
    return url;
  }
}

/** A blank new-tab page is not somewhere you were. */
function isBlank(url: string): boolean {
  return !url.trim() || url === "about:blank" || url.replace(/\/$/, "") === BROWSER_HOME_URL;
}

/** How much a shared word says, by where the plan says it. The project name
 *  is what a plan IS; a title word can be incidental ("harness" means one
 *  thing in VR goggles and another in agent tooling); body prose barely
 *  counts. */
const WEIGHT = { project: 5, title: 3, heading: 2, body: 0.8 } as const;
/** A word on the tab itself counts in full; one only in the mission goal
 *  around it counts for less. */
const CONTEXT = 0.6;
/** Below this, shared words are coincidence, not research. */
const MIN_RELEVANCE = 2.5;
/** Research done while a plan was being worked on usually belongs to it. Time
 *  only breaks ties between plans a page already shares words with — browsing
 *  during a planning session is not, by itself, research for that plan. This
 *  is the fuzzy part, and the obvious place for memory to learn the user. */
const TEMPORAL = 1.5;
const DAY_MS = 86_400_000;
function proximity(at: number | undefined, times: readonly number[] | undefined): number {
  if (!at || !times?.length) return 0;
  return Math.max(...times.map((t) => Math.exp(-Math.abs(at - t) / DAY_MS)));
}

/** Research first: explicitly linked tabs, then tabs ranked by how much of an
 *  unresolved plan's distinctive vocabulary they share, then the rest in the
 *  order given (most recent first). Deduped by browseId and by address. */
export function rankDoorTabs(plans: readonly PlanText[], tabs: readonly CandidateTab[]): DoorTab[] {
  const out: DoorTab[] = [];
  const seen = new Set<string>();
  const take = (t: DoorTab) => {
    const urlKey = t.url.replace(/\/$/, "");
    if (isBlank(t.url) || seen.has(t.browseId) || seen.has(urlKey)) return;
    seen.add(t.browseId);
    seen.add(urlKey);
    out.push(t);
  };

  const byId = new Map(tabs.map((t) => [t.browseId, t]));
  const links = plans
    .flatMap((p) => p.research.map((r) => ({ ...r, plan: p.title })))
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const r of links) {
    const live = byId.get(r.browseId);
    take({
      browseId: r.browseId,
      url: live?.url ?? r.url ?? "",
      title: live?.title || r.query,
      plan: r.plan,
      why: "linked from the plan",
      research: true,
    });
  }

  // Inverse document frequency over the plans: a word every plan uses
  // ("redline", "agent") says nothing about which plan a tab is for.
  const planTerms = plans.map((p) => ({
    plan: p,
    project: terms(p.project),
    title: terms(p.title),
    heading: terms(p.focus),
    body: terms(p.text),
  }));
  const df = new Map<string, number>();
  for (const p of planTerms)
    for (const t of new Set([...p.project, ...p.title, ...p.heading, ...p.body])) df.set(t, (df.get(t) ?? 0) + 1);
  // Normalised to 1 for a word only one plan uses, falling toward 0 for a word
  // every plan uses — so the threshold means the same with 2 plans or 8.
  const n = planTerms.length;
  const idf = (t: string) => Math.log(1 + n / (df.get(t) ?? 1)) / Math.log(1 + n);

  const scored = tabs.flatMap((tab) => {
    const own = terms(`${tab.title ?? ""} ${urlWords(tab.url)}`);
    const ctx = tab.context ? terms(tab.context) : new Set<string>();
    let best: { score: number; plan: string; shared: string[] } | null = null;
    for (const p of planTerms) {
      let score = 0;
      let ownHit = false;
      const shared: string[] = [];
      // The tab's own words first, so the "why" leads with them.
      for (const t of new Set([...own, ...ctx])) {
        const base = p.project.has(t) ? WEIGHT.project
          : p.title.has(t) ? WEIGHT.title
          : p.heading.has(t) ? WEIGHT.heading
          : p.body.has(t) ? WEIGHT.body
          : 0;
        if (!base) continue;
        const weight = base * (own.has(t) ? 1 : CONTEXT);
        score += weight * idf(t);
        if (own.has(t)) ownHit = true;
        shared.push(t);
      }
      // A mission's goal can strengthen a match but never make one: missions
      // collect unrelated browsing too, and a page counts as research for a
      // plan only when the page itself says something the plan says.
      if (ownHit && score >= MIN_RELEVANCE) {
        score += TEMPORAL * proximity(tab.at, p.plan.times);
        if (!best || score > best.score) best = { score, plan: p.plan.title, shared };
      }
    }
    return best ? [{ tab, ...best }] : [];
  });
  scored.sort((a, b) => b.score - a.score);
  for (const s of scored) {
    const { context: _context, at: _at, ...tab } = s.tab;
    take({ ...tab, plan: s.plan, why: s.shared.slice(0, 4).join(", ") });
  }

  for (const tab of tabs) take({ browseId: tab.browseId, url: tab.url, title: tab.title, mission: tab.mission });
  return out;
}

// ---- Loading ---------------------------------------------------------------

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

interface PlanSummaryLike {
  sessionId: string;
  planTitle?: string | null;
  projectName: string;
  updatedAt: number;
  status: string;
}

/** How many unresolved plans are read, and how stale one may be. A plan last
 *  touched weeks ago is not what the next tab is research for. */
const PLAN_LIMIT = 8;
const PLAN_MAX_AGE_MS = 21 * 24 * 60 * 60 * 1000;
const MISSION_LIMIT = 4;

/** Plan text, fetched once per plan version. Keyed by session, so a newer
 *  version replaces the older one instead of joining it, and capped at a few
 *  passes' worth of plans (docs/perf-budget.md rule 7): it used to keep every
 *  version of every plan read since launch. */
const planCache = new Map<string, [updatedAt: number, text: PlanText]>();
export const PLAN_CACHE_MAX = 4 * PLAN_LIMIT;

async function planText(invoke: Invoke, p: PlanSummaryLike): Promise<PlanText | null> {
  const hit = planCache.get(p.sessionId);
  if (hit?.[0] === p.updatedAt) return hit[1];
  const session = await invoke<{
    revisions: { rawPlanMarkdown?: string; receivedAt?: number; comments?: { createdAt: number; research?: { query: string; browseId: string; url?: string } }[] }[];
  } | null>("get_session", { id: p.sessionId }).catch(() => null);
  if (!session) return null;
  const latest = session.revisions[session.revisions.length - 1];
  const markdown = latest?.rawPlanMarkdown ?? "";
  const headings = markdown.match(/^#{1,4}\s+.+$/gm)?.join(" ") ?? "";
  const research = session.revisions.flatMap((r) =>
    (r.comments ?? []).flatMap((c) =>
      c.research?.browseId ? [{ ...c.research, createdAt: c.createdAt }] : [],
    ),
  );
  const value: PlanText = {
    sessionId: p.sessionId,
    title: p.planTitle?.trim() || p.projectName,
    project: p.projectName,
    focus: headings,
    times: session.revisions.flatMap((r) => (r.receivedAt ? [r.receivedAt] : [])),
    text: markdown.slice(0, 20000),
    research,
  };
  planCache.delete(p.sessionId);
  planCache.set(p.sessionId, [p.updatedAt, value]);
  if (planCache.size > PLAN_CACHE_MAX) planCache.delete(planCache.keys().next().value!);
  return value;
}

/** Every tab the door may offer: recent missions' tabs (with the mission's
 *  goal as context) and regular browsing, most recent workspace first. */
/** When each tab was last discussed, from the browser's per-tab chat memory
 *  (written by BrowserPane under this key). Missing or malformed is empty. */
const BROWSER_CHAT_STATE_KEY = "redline.browser.chatState";
function readTabActivity(storage: Pick<Storage, "getItem"> | null): Map<string, number> {
  try {
    const raw = JSON.parse(storage?.getItem(BROWSER_CHAT_STATE_KEY) ?? "{}");
    return new Map(
      Object.entries(raw as Record<string, { at?: unknown }>).flatMap(([id, v]) =>
        typeof v?.at === "number" ? [[id, v.at] as [string, number]] : [],
      ),
    );
  } catch {
    return new Map();
  }
}

export async function candidateTabs(invoke: Invoke, storage: Pick<Storage, "getItem"> | null): Promise<CandidateTab[]> {
  type Saved = { tabs?: { browseId?: string | null; url?: string; title?: string }[] } | null;
  const read = (id: string) => invoke<Saved>("browser_workspace_read", { workspaceId: id }).catch(() => null);
  const missions = await invoke<{ missionId: string; title: string; goal: string; status: string; updatedAt: number }[]>(
    "mission_list",
  ).catch(() => []);
  const recent = missions
    .filter((m) => m.status !== "archived")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MISSION_LIMIT);
  const [regular, ...saved] = await Promise.all([read("regular"), ...recent.map((m) => read(m.missionId))]);
  const talkedAt = readTabActivity(storage);
  const toTabs = (s: Saved, context?: string, fallbackAt?: number, mission?: string): CandidateTab[] =>
    (s?.tabs ?? []).flatMap((t) =>
      t.browseId && t.url
        ? [{ browseId: t.browseId, url: t.url, title: t.title, context, mission, at: talkedAt.get(t.browseId) ?? fallbackAt }]
        : [],
    );
  return [
    ...saved.flatMap((s, i) => toTabs(s, `${recent[i].title} ${recent[i].goal}`, recent[i].updatedAt, recent[i].title)),
    ...toTabs(regular),
  ];
}

/** The Browser row's tabs, research for unresolved plans first. */
export async function loadDoorTabs(
  invoke: Invoke,
  plans: readonly PlanSummaryLike[],
  now = Date.now(),
  storage: Pick<Storage, "getItem"> | null = typeof localStorage === "undefined" ? null : localStorage,
): Promise<DoorTab[]> {
  const unresolved = plans
    .filter((p) => p.status === "in_review" && now - p.updatedAt <= PLAN_MAX_AGE_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, PLAN_LIMIT);
  const [texts, tabs] = await Promise.all([
    Promise.all(unresolved.map((p) => planText(invoke, p))),
    candidateTabs(invoke, storage),
  ]);
  return rankDoorTabs(texts.filter((t): t is PlanText => !!t), tabs);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Plans and chats: up to `perKind` each, most recent first. Tabs: up to
 *  `browseLimit`, already ranked by `loadDoorTabs` — they stack as a list, so
 *  there is room for more of them. Fixed kind order so the door reads as
 *  labelled sections. */
export function doorRecents(
  input: {
    plans: readonly { sessionId: string; planTitle?: string | null; projectName: string; updatedAt: number }[];
    chats: readonly { companionId: string; title: string; status: string; updatedAt: number }[];
    tabs: readonly DoorTab[];
  },
  perKind = 2,
  browseLimit = 10,
): DoorRecent[] {
  const plans = [...input.plans]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, perKind)
    .map((p): DoorRecent => {
      const label = p.planTitle?.trim() || p.projectName;
      return { kind: "plan", id: p.sessionId, label, detail: `Plan · ${p.projectName} — ${label}` };
    });
  const chats = input.chats
    .filter((c) => c.status !== "archived")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, perKind)
    .map((c): DoorRecent => {
      const label = c.title.trim() || "Untitled chat";
      return { kind: "chat", id: c.companionId, label, detail: `Chat — ${label}` };
    });
  const tabs = input.tabs
    .filter((t) => !isBlank(t.url))
    .slice(0, browseLimit)
    .map((t): DoorRecent => {
      const label = t.title?.trim() || hostOf(t.url);
      // The hover says where it lives and, when known, what it was for.
      const why = t.plan ? `\nResearch for “${t.plan}”` : t.mission ? `\nFrom the “${t.mission}” mission` : "";
      return { kind: "browse", id: t.browseId, label, detail: `${label}\n${t.url}${why}`, url: t.url, host: hostOf(t.url), research: t.research };
    });
  return [...plans, ...chats, ...tabs];
}
