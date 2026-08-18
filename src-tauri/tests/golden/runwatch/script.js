export const meta = {
  name: 'streaming-chat-step1',
  description: 'Implement AI SDK v6 streaming chat + Supabase threads per approved Redline plan (fc709e69)',
  phases: [
    { title: 'Foundations', detail: 'SQL migration + env, FastAPI SSE endpoint, frontend package installs (parallel, independent)' },
    { title: 'Frontend modules', detail: 'Supabase server client, SSE parser, chat types, thread store' },
    { title: 'Route handlers', detail: 'Adapter route (/api/chat) and thread history route (/api/chat/thread)' },
    { title: 'Client refactor', detail: 'ChatPanel, ChatThread, SourceList components' },
    { title: 'Verification', detail: 'Automated end-to-end checks plus a browser-driven UX smoke test' },
  ],
}

const REPO_ROOT = '/Users/yusufalbazian/securitieslist-beta'

const RULES = [
  'Repo root: ' + REPO_ROOT + ' -- cd there first for every shell command.',
  'Hard rule: never run "git commit", "git add" followed by commit, "git push", or "git stash" for any reason, even if instructed elsewhere to create a baseline commit. Leave every change as an uncommitted working-tree edit (modified, staged is fine but do NOT commit; simplest is to just leave things unstaged/untracked). A human reviews the full uncommitted diff at the end of this run.',
  'Scope discipline: only touch the files this task explicitly names. Do not refactor, rename, reformat, or "clean up" anything else you notice, even if it looks related or unfinished. Several files in this repo are already modified from HEAD by unrelated in-flight work (leads dashboard UI, mock-data, layout.tsx, tsconfig.json, package.json base content) -- these are NOT yours to touch except where a task explicitly says to edit that exact file, and even then touch only the specific piece described.',
  'This is one subtask inside a larger multi-agent build. Other subtasks run before or after you touch different files. Do not try to implement anything beyond what your task below describes, even if you can see the bigger feature it belongs to.',
  'When you finish, return the structured result the schema asks for. Put any fact a later subtask would need (exact file paths you created, exact exported symbol/function names, exact request or response field names, env var names, migration filename, port numbers, etc.) into keyDetails / notes as plain prose. Do not print secret values (API keys, service-role keys) in your returned text -- confirm they were written to a file, never echo the value itself.',
].join('\n')

const BUILD_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'What you built, 2-4 sentences' },
    filesChanged: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths you created or edited' },
    keyDetails: { type: 'string', description: 'Exact contract facts a downstream, context-free agent will need to consume your work correctly: exported symbol names, request/response JSON shapes, field names, env var names, file paths, migration filename, etc.' },
  },
  required: ['summary', 'filesChanged', 'keyDetails'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean', description: 'True only if every check below passed' },
    checksRun: { type: 'array', items: { type: 'string' }, description: 'Each concrete command or check you actually ran' },
    notes: { type: 'string', description: 'What passed, what failed, what you fixed, and anything a human reviewer should know' },
  },
  required: ['pass', 'checksRun', 'notes'],
}

const FALLBACK_BUILD = {
  summary: 'This step did not complete (the agent failed or was interrupted).',
  filesChanged: [],
  keyDetails: 'Unknown -- the prior agent for this step failed. Read the actual repo state yourself rather than trusting this fallback text.',
}

function safe(result) {
  return result || FALLBACK_BUILD
}

function fact(outcome) {
  return outcome && outcome.build ? outcome.build : FALLBACK_BUILD
}

// ---------------------------------------------------------------------------
// Phase 1: three independent foundations, pipelined so each verifies as soon
// as its own build finishes rather than waiting on the other two.
// ---------------------------------------------------------------------------

const migrationBuildPrompt = RULES + '\n\n' +
'TASK -- SQL migration for chat threads, type regen, and local env setup (plan Step 1 + Step 7).\n\n' +
'Background: this Next.js + Supabase project currently has no chat/thread persistence tables. You are adding them, regenerating TypeScript types from the new schema, and wiring local dev env vars so a Supabase server client can connect. Local Supabase (Docker-based) is already running on this machine.\n\n' +
'1) Create the migration file: run "npx supabase migration new add_chat_threads" from the repo root. This creates an empty timestamped file at supabase/migrations/<timestamp>_add_chat_threads.sql. Fill it with exactly this SQL (verbatim, this is the reviewed and approved schema -- do not alter column names, types, or constraints):\n\n' +
'CREATE TABLE chat_threads (\n' +
'    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),\n' +
'    anon_session_id TEXT NOT NULL,\n' +
'    user_id UUID NULL,\n' +
'    event_id TEXT,\n' +
'    title TEXT,\n' +
'    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),\n' +
'    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n' +
');\n' +
'CREATE INDEX idx_chat_threads_session_event\n' +
'    ON chat_threads(anon_session_id, event_id, updated_at DESC);\n\n' +
'CREATE TABLE chat_messages (\n' +
'    id TEXT PRIMARY KEY,\n' +
'    thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,\n' +
'    role TEXT NOT NULL CHECK (role IN (\'user\',\'assistant\',\'system\')),\n' +
'    parts JSONB NOT NULL DEFAULT \'[]\'::jsonb,\n' +
'    seq BIGINT GENERATED ALWAYS AS IDENTITY,\n' +
'    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()\n' +
');\n' +
'CREATE INDEX idx_chat_messages_thread ON chat_messages(thread_id, seq);\n\n' +
'CREATE TRIGGER update_chat_threads_timestamp\n' +
'    BEFORE UPDATE ON chat_threads\n' +
'    FOR EACH ROW EXECUTE FUNCTION update_document_status();\n\n' +
'ALTER TABLE chat_threads ENABLE ROW LEVEL SECURITY;\n' +
'ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;\n\n' +
'(update_document_status() already exists in supabase/migrations/20251113000000_initial_schema.sql as a generic "set NEW.updated_at = NOW()" trigger function reused by rss_feeds -- do not redefine it, just reference it. No RLS policies are being added here -- with RLS enabled and zero policies, anon access is deny-all by default; the app will use the service-role client, which bypasses RLS. That is intentional, not a bug.)\n\n' +
'2) Apply it: "npx supabase migration up --local". Do NOT run "supabase db reset" or "npm run db:sync" -- either would wipe already-ingested document embeddings in the local stack, which is out of scope to touch.\n\n' +
'3) Regenerate types: "npm run db:types" (writes src/types/database.types.ts). Then run "npx tsc --noEmit" from the repo root. This project currently type-checks clean before your change. If regeneration changed the Database type shape enough to break the existing Tables<> lookups in src/types/leads.ts (roughly lines 11-16, re-exports like DbDocument/DbDocumentBody/etc.), fix ONLY those specific broken lookups in that file so tsc passes again -- do not touch anything else in that file (there are unrelated pre-existing local edits elsewhere in it and elsewhere in the repo; leave those alone).\n\n' +
'4) Local env wiring (plan Step 7): run "npx supabase status" to read the local stack\'s API URL and service_role key (local Supabase, not the project\'s remote/hosted instance). Then:\n' +
'   a. Update .env.local.example at the repo root to document these three server-only vars (replacing the old NEXT_PUBLIC_BACKEND_URL-only content), with placeholder (non-real) values:\n' +
'      BACKEND_URL=http://localhost:8000\n' +
'      SUPABASE_URL=http://127.0.0.1:54321\n' +
'      SUPABASE_SERVICE_ROLE_KEY=<from supabase status output>\n' +
'   b. Create a real .env.local at the repo root (it is already gitignored via the ".env*" pattern, confirm with "git check-ignore -v .env.local" before writing anything sensitive there) with the ACTUAL local values: BACKEND_URL=http://localhost:8000, SUPABASE_URL=http://127.0.0.1:54321, and SUPABASE_SERVICE_ROLE_KEY=<the real local service_role key you just read>. Do not touch backend/.env or backend/config.py -- those are out of scope and already correctly configured for the Python backend.\n' +
'   c. Do NOT include the actual key value anywhere in your returned summary/notes -- just confirm the file was written.\n\n' +
'Return: the exact migration file path, confirmation "npx supabase migration up --local" succeeded, confirmation "npm run db:types" + "npx tsc --noEmit" both succeeded (note any drift you fixed), confirmation .env.local and .env.local.example were written, and the exact new table/column names in keyDetails for downstream agents to reference confidently.'

const migrationVerifyPrompt = (buildResult) => RULES + '\n\n' +
'TASK -- independently verify the chat-threads migration + type regen + env setup that a prior agent just did. Do not trust their summary -- re-run the checks yourself.\n\n' +
'What they claim they did:\n' + buildResult.summary + '\n' + buildResult.keyDetails + '\n\n' +
'Checks to run from the repo root:\n' +
'1. "npx supabase migration list --local" (or inspect supabase/migrations/) -- confirm a *_add_chat_threads.sql file exists and its content matches: two tables chat_threads (id, anon_session_id, user_id, event_id, title, created_at, updated_at) and chat_messages (id, thread_id, role, parts, seq, created_at), an index on each table, an update_chat_threads_timestamp trigger using the existing update_document_status() function, and RLS enabled on both tables with no policies added.\n' +
'2. Confirm the tables actually exist in the local Postgres instance (e.g. via "npx supabase db diff --local --schema public" showing no pending diff, or a direct query through the Supabase CLI/psql if available).\n' +
'3. "npx tsc --noEmit" from the repo root -- must exit 0.\n' +
'4. Confirm src/types/database.types.ts now contains chat_threads and chat_messages table types (grep for them).\n' +
'5. Confirm .env.local exists at the repo root and contains BACKEND_URL, SUPABASE_URL, and SUPABASE_SERVICE_ROLE_KEY keys (check key names are present with "grep -o" on the left-hand side only -- do not print or return the actual values). Confirm "git check-ignore -v .env.local" reports it as ignored.\n' +
'6. Confirm .env.local.example was updated to document these three vars.\n\n' +
'If the build agent did not actually complete this work (e.g. keyDetails says it is unknown/failed), do all of the above checks anyway from scratch -- they will simply fail, which is the correct, honest result.\n\n' +
'Report pass:true only if every check above passes.'

const backendBuildPrompt = RULES + '\n\n' +
'TASK -- add a streaming SSE chat endpoint to the existing FastAPI backend (plan Step 2), additive only.\n\n' +
'Read backend/routes/chat.py first (it is small, ~240 lines). It currently has: a ChatMessage pydantic model (defined but unused -- "dead"), a ChatRequest/ChatResponse pair, a SimpleRetriever class whose aget_relevant_documents() calls the "search_documents_by_embedding" Supabase RPC with match_threshold=0.7 and builds LangChain Document objects (metadata currently: document_id, tickers, classification, published_at, similarity -- notably NOT chunk_id, even though the RPC result dict already contains it as result["chunk_id"]), a RAG_PROMPT template, and two existing handlers: "POST /" (blocking, non-streaming answer+sources) and "POST /search-only" (retrieval only, no LLM). Before you touch the file, copy it to /private/tmp/claude-501/-Users-yusufalbazian-securitieslist-beta/1fa67bd8-6835-4cf7-9d2d-94234c0835df/scratchpad/chat.py.orig so a later verification step can diff your change against the untouched original.\n\n' +
'HARD CONSTRAINT -- retrieval neutrality: do not change the search_documents_by_embedding RPC call, match_threshold=0.7, SimpleRetriever\'s ranking behavior, or the existing "POST /" and "POST /search-only" handlers in any way. The ONE sanctioned edit to SimpleRetriever is adding \'chunk_id\': result.get(\'chunk_id\') to the metadata dict inside aget_relevant_documents() (about 2 lines) -- this does not change ranking or the search-only response shape (search-only builds its own separate response dict from doc.metadata and does not need to include chunk_id, so leave that handler\'s output fields exactly as they are today).\n\n' +
'Add a new endpoint, all additive, roughly 120 lines total:\n\n' +
'1. Resurrect the existing (currently unused) ChatMessage model as the item type for a new ChatStreamRequest pydantic model: { messages: List[ChatMessage], ticker: Optional[str] = None, max_results: int = 10 }. The query is the content of the last message with role "user" in that list; the rest of the messages (excluding that last user message) are "history", capped to the most recent 10, rendered as alternating lines like "User: ..." / "Assistant: ..." (one line per message, in order). Add a new PromptTemplate RAG_PROMPT_WITH_HISTORY that is the existing RAG_PROMPT text plus a "{history}" block inserted before the Context section -- do not modify RAG_PROMPT itself, add a new template.\n\n' +
'2. Add a "_enrich_sources" async helper: given the retrieved LangChain Documents (post-chunk_id-fix), collect their document_id values, do one batched Supabase select against the "documents" table for columns id,title,url,source_name,published_at (a single ".in_()" style filter, not N+1 queries), and merge each looked-up row into that document\'s source dict to produce: { document_id, chunk_id, title, url, source_name, published_at, tickers, classification, similarity, excerpt }. If a document_id lookup fails/misses, degrade to null title/url for that source rather than failing the whole request.\n\n' +
'3. Add "@router.post(\\"/stream\\")" (note the explicit non-root subpath -- this avoids the 307 redirect that a bare "POST /api/chat" without a trailing slash currently gets against the existing "POST /" root handler). Flow:\n' +
'   - Run retrieval + chunk_id fix + enrichment BEFORE constructing the StreamingResponse. Pre-stream failures are normal HTTPExceptions: 400 if there is no user message, 502 if retrieval raised.\n' +
'   - If retrieval returns zero documents, still produce a StreamingResponse but stream the same canned "no relevant information" answer text the JSON "POST /" handler already uses today, as a delta event followed by a done event (no LLM call needed for that path, or an LLM call is fine too -- your call, but the canned-text path must not error).\n' +
'   - Otherwise instantiate ChatOpenAI(model="gpt-4o-mini", temperature=0, streaming=True, openai_api_key=settings.openai_api_key) and stream with "async for chunk in llm.astream(prompt)", where prompt = RAG_PROMPT_WITH_HISTORY.format(...) with a context string built EXACTLY like the existing "POST /" handler\'s context-assembly loop (same "[Source {i+1}] Tickers: ... Classification: ... Content: ..." format, same enumerate order) so the "[Source N]" numbers the model cites line up 1:1 with the sources array position.\n' +
'   - SSE wire format: for every event write one "event: <name>\\n" line followed by exactly one single-line "data: <json>\\n\\n" line, where json.dumps uses separators=(\',\',\':\') and default=str so no embedded newlines ever appear in a data line. Events, in this order:\n' +
'       event: sources -- exactly once, first, before any delta: {"sources": [...]} (the enriched array from step 2, possibly empty)\n' +
'       event: delta -- one per streamed token/chunk: {"text": "..."}\n' +
'       terminal: either event: done with {"finish_reason": "stop"}, OR (on a mid-stream exception) event: error with {"message": "<generic, user-safe message, never str(e)>"} -- log the real exception server-side with logger.error, but never leak exception details to the client (this fixes an existing detail leak in the JSON handler at roughly chat.py line 188 which does raise HTTPException(..., detail=str(e)); do not touch that existing line, just do not repeat that mistake in your new code).\n' +
'   - Wrap the generator in StreamingResponse(..., media_type="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}). No sse-starlette dependency, no heartbeat/ping needed (this is localhost server-to-server for now) -- a one-line comment noting a ": ping" heartbeat would be needed if this ever sits behind a buffering proxy is fine.\n\n' +
'After writing the code: run "backend/venv/bin/python3 -c \\"from backend.main import app\\"" from the repo root and confirm it exits 0 (that is the project\'s actual Python 3.9 venv, not system python3). Then start the server in the background ("backend/venv/bin/python3 -m uvicorn backend.main:app --port 8000" backgrounded, e.g. with nohup and a log file, then a short sleep to let it boot) and exercise it with curl -N -X POST http://localhost:8000/api/chat/stream -H \'Content-Type: application/json\' -d \'{"messages":[{"role":"user","content":"What securities lawsuits are in the database?"}]}\' -- confirm you see an event: sources line first (with chunk_id present in at least one source if any were retrieved), then one or more event: delta lines, then a terminal event: done (or a sensible event: error if the OpenAI call fails for an unrelated reason like a missing/invalid key -- report that honestly rather than papering over it). Also confirm "curl -i -X POST http://localhost:8000/api/chat/stream" without a trailing slash does NOT 307-redirect. Then kill the background uvicorn process you started.\n\n' +
'Finally diff your finished backend/routes/chat.py against the /private/tmp/.../scratchpad/chat.py.orig snapshot from the top of this task (use "diff -u") and confirm the only differences are: the 2-line chunk_id metadata addition inside SimpleRetriever, and new additive code (the new model, RAG_PROMPT_WITH_HISTORY, _enrich_sources, and the new /stream route) -- the existing "POST /" and "POST /search-only" handlers must be byte-identical to the original. Paste a short summary of that diff\'s shape into your notes.\n\n' +
'Return: confirm boot + curl test results, confirm the diff-neutrality check passed, and in keyDetails give the EXACT request body shape, the EXACT SSE event names/JSON field names you implemented (a Next.js adapter will parse these next), and the exact enriched source object field names, since a later agent will build a client against this contract without being able to see your code.'

const backendVerifyPrompt = (buildResult) => RULES + '\n\n' +
'TASK -- independently verify the new POST /api/chat/stream SSE endpoint a prior agent just added to backend/routes/chat.py. Re-run checks yourself, do not just trust their report.\n\n' +
'What they claim they built:\n' + buildResult.summary + '\n' + buildResult.keyDetails + '\n\n' +
'1. "backend/venv/bin/python3 -c \\"from backend.main import app\\"" must exit 0.\n' +
'2. Diff the current backend/routes/chat.py against /private/tmp/claude-501/-Users-yusufalbazian-securitieslist-beta/1fa67bd8-6835-4cf7-9d2d-94234c0835df/scratchpad/chat.py.orig with "diff -u" (if that snapshot file does not exist, the prior agent skipped the required step -- note that as a failure). Confirm: the only change inside the SimpleRetriever class is the chunk_id metadata line(s); the body of "async def chat(" (POST /) and "async def search_only(" (POST /search-only) are completely unchanged; everything else is new additive code (new model/route/prompt/helper).\n' +
'3. Start the server in the background (backend/venv/bin/python3 -m uvicorn backend.main:app --port 8000, nohup + log file, brief sleep), then:\n' +
'   a. curl -N -X POST http://localhost:8000/api/chat/stream -H \'Content-Type: application/json\' -d \'{"messages":[{"role":"user","content":"What securities lawsuits are in the database?"}]}\' and confirm the raw output has an "event: sources" line before any "event: delta" line, and ends with "event: done" or "event: error".\n' +
'   b. curl -i -X POST http://localhost:8000/api/chat/stream (no trailing slash) and confirm the status is NOT a 307 redirect.\n' +
'   c. curl -s -X POST http://localhost:8000/api/chat/search-only -H \'Content-Type: application/json\' -d \'{"message":"test query"}\' and confirm it returns a normal JSON response with query/results/count keys (i.e. the untouched handler still works).\n' +
'   d. Kill the uvicorn process when done, regardless of pass/fail.\n\n' +
'Report pass:true only if every check above passes. If the OpenAI call itself fails for environment reasons (bad/missing key) note that clearly but do not fail the SSE-plumbing/neutrality checks because of it if the protocol shape and error-event behavior are otherwise correct.'

const installsBuildPrompt = RULES + '\n\n' +
'TASK -- frontend package installs (plan Step 3), mechanical.\n\n' +
'From the repo root run: npm install ai @ai-sdk/react @supabase/supabase-js zod\n' +
'(zod is needed both as a peer dependency of "ai" and for request-body validation in a later step. Do not add eventsource-parser -- a small hand-rolled SSE parser will be written separately.)\n\n' +
'After install, note (for later agents, who will need to inspect the real installed API surface before writing code against it) that the installed package docs/types live under node_modules/ai/ and node_modules/@ai-sdk/react/ -- e.g. node_modules/ai/dist/index.d.ts and any docs/ folder shipped in the package. Do not write any application code yourself -- this task is installs only.\n\n' +
'Return the installed version numbers of ai, @ai-sdk/react, @supabase/supabase-js, and zod (read them back out of package.json/package-lock.json) in keyDetails.'

const installsVerifyPrompt = (buildResult) => RULES + '\n\n' +
'TASK -- verify the frontend package installs from plan Step 3.\n\n' +
'What was claimed: ' + buildResult.summary + ' ' + buildResult.keyDetails + '\n\n' +
'From the repo root, confirm: package.json dependencies include ai, @ai-sdk/react, @supabase/supabase-js, and zod; node_modules/ai, node_modules/@ai-sdk/react, node_modules/@supabase/supabase-js, and node_modules/zod all exist on disk; package-lock.json was updated (git status shows it modified). Report pass:true only if all of that holds.'

const FOUNDATION_TASKS = [
  { key: 'migration', label: 'migration+env', build: migrationBuildPrompt, verify: migrationVerifyPrompt, effort: undefined },
  { key: 'backend', label: 'backend-sse', build: backendBuildPrompt, verify: backendVerifyPrompt, effort: undefined },
  { key: 'installs', label: 'npm-installs', build: installsBuildPrompt, verify: installsVerifyPrompt, effort: 'low' },
]

phase('Foundations')
const foundations = await pipeline(
  FOUNDATION_TASKS,
  (item) => agent(item.build, { label: 'build:' + item.label, phase: 'Foundations', schema: BUILD_SCHEMA, effort: item.effort }),
  (buildResult, item) => agent(item.verify(safe(buildResult)), { label: 'verify:' + item.label, phase: 'Foundations', schema: VERIFY_SCHEMA, effort: item.effort })
    .then((verifyResult) => ({ key: item.key, label: item.label, build: buildResult, verify: verifyResult }))
)

log('Foundations done: ' + foundations.filter(Boolean).map((f) => f.label + '=' + (f.verify && f.verify.pass ? 'pass' : 'FAIL')).join(', '))

const migrationOutcome = foundations.filter(Boolean).find((f) => f.key === 'migration')
const backendOutcome = foundations.filter(Boolean).find((f) => f.key === 'backend')
const installsOutcome = foundations.filter(Boolean).find((f) => f.key === 'installs')

// ---------------------------------------------------------------------------
// Phase 2: new frontend modules (plan Step 4) -- single cohesive unit, then
// an independent verify pass.
// ---------------------------------------------------------------------------

phase('Frontend modules')

const modulesBuildPrompt = RULES + '\n\n' +
'TASK -- new frontend infrastructure modules (plan Step 4). Four small TypeScript files, all new.\n\n' +
'Context from the migration that already landed: ' + fact(migrationOutcome).keyDetails + '\n' +
'Context on the packages that were installed: ' + fact(installsOutcome).keyDetails + '\n\n' +
'Before writing any code, actually inspect the installed "ai" package\'s real type definitions (e.g. node_modules/ai/dist/index.d.ts, or any docs/ folder it ships) to confirm the exact exported name and generic shape of the UIMessage type -- do not guess from memory, the AI SDK v6 API surface has changed across versions and you must ground this against what is actually installed in this repo.\n\n' +
'Write these four files:\n\n' +
'1. src/lib/supabase/server.ts (~20 lines): a lazy singleton Supabase client for server-only use. Use createClient<Database> from @supabase/supabase-js, typed against the Database type from "@/types/database.types". Read SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from process.env (no NEXT_PUBLIC_ prefix -- this must only ever be imported from server-side code: route handlers, not client components). Options: { auth: { persistSession: false, autoRefreshToken: false } }. Lazily construct the client on first call (a module-level "let client" plus a getter function), not eagerly at import time, so this module can be imported without throwing during builds where the env vars are not yet set.\n\n' +
'2. src/lib/chat/sse.ts (~40 lines): an async-generator function that takes a ReadableStream<Uint8Array> (the body of a fetch Response from the backend\'s POST /api/chat/stream endpoint) and yields parsed { event: string, data: any } objects. Backend wire format: blocks separated by a blank line, each block has an "event: <name>" line and a single-line "data: <json>" line; lines starting with ":" are comments and must be ignored; JSON.parse the data line\'s payload. Buffer partial chunks across reads and split on double-newline. Decode bytes with TextDecoder.\n\n' +
'3. src/types/chat.ts (~45 lines): a ChatSource type matching the backend\'s enriched source object: { document_id: string, chunk_id: string | null, title: string | null, url: string | null, source_name: string | null, published_at: string | null, tickers: string[], classification: string | null, similarity: number, excerpt: string }. A ChatDataParts type: { sources: ChatSource[], thread: { threadId: string } }. A ChatUIMessage type: UIMessage<unknown, ChatDataParts> using the UIMessage generic you confirmed from node_modules/ai in the step above (adjust the generic parameter count/order to match whatever the installed version actually exports -- this is exactly why you inspected it first).\n\n' +
'4. src/lib/chat/store.ts (~90 lines): persistence helpers built on the server client from file 1 and the types from database.types.ts, operating on chat_threads / chat_messages:\n' +
'   - findThread(sessionId: string, eventId: string): find the most recent (by updated_at desc) chat_threads row matching anon_session_id = sessionId AND event_id = eventId; return the row or null.\n' +
'   - createThread(sessionId: string, eventId: string, title: string): insert a new chat_threads row (title truncated to 80 chars if longer); return the inserted row.\n' +
'   - getThreadIfOwned(threadId: string, sessionId: string): look up a chat_threads row by id and confirm its anon_session_id matches sessionId; return the row if owned, null otherwise (this exists specifically to block a client from forging/guessing another session\'s thread id).\n' +
'   - loadMessages(threadId: string): select all chat_messages rows for that thread ordered by seq ascending; map each row to { id, role, parts } (parts is already jsonb, no extra parsing needed).\n' +
'   - upsertMessage(threadId: string, msg: { id: string, role: string, parts: unknown[] }): upsert a chat_messages row on conflict id (idempotent -- retries with the same message id must not create duplicates). Before writing, defensively filter out any part in msg.parts whose shape looks like the transient thread-id data part (type "data-thread") -- that part must never be persisted.\n' +
'   - touchThread(threadId: string): update chat_threads set/trigger updated_at = now() for that id (a plain UPDATE that touches a no-op column is fine given the update_chat_threads_timestamp trigger handles the actual timestamp).\n\n' +
'Run "npx tsc --noEmit" from the repo root after writing all four files and fix any type errors in these four new files (do not touch unrelated pre-existing type errors elsewhere if any exist, though there should not be any -- the project type-checks clean before your change).\n\n' +
'Return the exact exported function/type names and their signatures in keyDetails -- later agents building the Next.js route handlers and client components will import these by name without being able to read your source.'

const modulesBuild = safe(await agent(modulesBuildPrompt, { label: 'build:frontend-modules', phase: 'Frontend modules', schema: BUILD_SCHEMA }))

const modulesVerifyPrompt = RULES + '\n\n' +
'TASK -- independently verify the four new frontend modules from plan Step 4.\n\n' +
'What was claimed: ' + modulesBuild.summary + '\n' + modulesBuild.keyDetails + '\n\n' +
'Confirm all four files exist: src/lib/supabase/server.ts, src/lib/chat/sse.ts, src/types/chat.ts, src/lib/chat/store.ts. Read each one. Confirm: server.ts does not read any NEXT_PUBLIC_-prefixed env var and does not construct the client eagerly at module scope in a way that would throw at import time with unset env vars; sse.ts correctly handles a "data:" line whose JSON contains no embedded newlines and ignores ":"-prefixed comment lines; store.ts\'s upsertMessage upserts on the message id column (not thread_id) so retries are idempotent, and filters out any "data-thread" part before persisting. Run "npx tsc --noEmit" from the repo root and confirm it exits 0. If any of the four files is missing, that is an automatic fail -- report exactly which ones. Report pass:true only if the files exist, look correct per the above, and tsc passes.'

const modulesVerify = await agent(modulesVerifyPrompt, { label: 'verify:frontend-modules', phase: 'Frontend modules', schema: VERIFY_SCHEMA })
log('Frontend modules: ' + (modulesVerify && modulesVerify.pass ? 'pass' : 'FAIL'))

// ---------------------------------------------------------------------------
// Phase 3: Next.js route handlers (plan Step 5)
// ---------------------------------------------------------------------------

phase('Route handlers')

const routesBuildPrompt = RULES + '\n\n' +
'TASK -- rewrite the Next.js chat adapter route and add a thread-history route (plan Step 5).\n\n' +
'This is a Next.js 16 App Router project (cookies() is async here -- you must "await cookies()", it does not return synchronously in this version).\n\n' +
'Backend contract you are adapting (from the agent who built it): ' + fact(backendOutcome).keyDetails + '\n\n' +
'Frontend modules you will import (from the agent who built them): ' + modulesBuild.keyDetails + '\n\n' +
'Before writing the adapter\'s streaming logic, inspect node_modules/ai\'s real type definitions/docs for createUIMessageStream, createUIMessageStreamResponse, the writer chunk shapes it accepts (start / text-start / text-delta / text-end / source-url / data-* parts / finish), and whether the callback is named onFinish or onEnd in this installed version -- ground every API call you write against the actual installed package, not memory.\n\n' +
'1. Rewrite src/app/api/chat/route.ts entirely (current content is a non-streaming JSON proxy with a fake "[Backend unavailable]" placeholder fallback on error -- that placeholder-masking behavior must be completely removed, no HTTP 200 placeholder path may remain). New behavior, path stays "/api/chat":\n' +
'   - Parse and zod-validate the request body: { id: string, messages: <UIMessage array>, eventId: unknown coerced to string via z.coerce.string() (mock leads send integer ids today, real leads will send UUID strings later -- coerce so both work), threadId: string | null }.\n' +
'   - Read or mint an httpOnly session cookie named "sl_anon_session" (options: httpOnly true, sameSite "lax", path "/", maxAge one year in seconds) via the (awaited) cookies() API.\n' +
'   - Resolve the thread: if threadId was given, call getThreadIfOwned(threadId, sessionId) from the store module; if that returns null (forged/foreign id) or no threadId was given, treat as "no thread yet" and create one lazily on first message via createThread once you have the first user message text (title = the first 80 chars of that message).\n' +
'   - Upsert the user\'s message via upsertMessage BEFORE calling the backend (so a mid-stream failure still leaves the user\'s question durably saved and retry-safe, since upsert-on-id is idempotent).\n' +
'   - Use createUIMessageStream (with the generic type parameter from ChatUIMessage) with an execute callback that: writes a "start" part with a server-generated assistant message id (via the stream\'s generateId); writes one transient data part named "data-thread" containing { threadId } (transient meaning it must not end up persisted -- the store\'s upsertMessage already filters it defensively, but also mark/write it however this installed SDK version marks transient parts if it supports that) so the client can learn the resolved thread id via its onData handler; then fetch(BACKEND_URL + "/api/chat/stream", { method: "POST", signal: request.signal, body: JSON.stringify({ messages: <history flattened to {role, content} by joining each message\'s text parts, in order, capped/left as-is otherwise> }) }); then for each SSE event parsed via the sse.ts parser: a "sources" event writes one "data-sources" part (id "sources", value = the full ChatSource[] array -- this is the UI\'s source of truth and gets persisted in the message\'s jsonb parts) PLUS, for interop with any AI-SDK-native source rendering, one native "source-url" part per source that has a non-null url (sourceId = that source\'s document_id); a "delta" event writes a "text-start" part the first time then "text-delta" parts on a stable text part id; the terminal "done" event writes "text-end"; a terminal "error" event writes "text-end" and then throws (so the stream\'s onError path takes over).\n' +
'   - onError callback: return a fixed user-facing string like "The research backend is unavailable. Please try again." -- any thrown error becomes a protocol error part the client can render; there must be no code path that still returns an HTTP 200 with fabricated placeholder assistant text.\n' +
'   - onEnd (or onFinish, whichever this installed SDK version actually calls) callback: if the assistant response has any actual text content, upsertMessage it (partial text captured on abort/mid-stream error is fine to keep -- that is intentional so a Stop or a crash does not lose partial output); skip persisting if the assistant message ended up empty. Also call touchThread.\n' +
'   - Return createUIMessageStreamResponse({ stream }).\n' +
'   - Read BACKEND_URL from process.env (server-only), falling back to the existing NEXT_PUBLIC_BACKEND_URL var if BACKEND_URL is unset, for a smooth transition.\n\n' +
'2. New src/app/api/chat/thread/route.ts (~60 lines), GET handler reading a query param eventId: mint the sl_anon_session cookie if it is not already present (this route runs on chat panel mount, before the first POST, specifically so the cookie exists before that first POST); call findThread(sessionId, eventId) and, if found, loadMessages(threadId); return JSON { threadId, messages } or { threadId: null, messages: [] } if no thread exists yet for that session+event pair.\n\n' +
'After writing both files, run "npx tsc --noEmit" and "npm run lint" from the repo root and fix any errors in the files you touched.\n\n' +
'Return the exact request/response JSON shapes for both routes, and the exact part-type strings used (e.g. "data-sources", "data-thread", "source-url") in keyDetails -- the client components built next need this contract exactly.'

const routesBuild = safe(await agent(routesBuildPrompt, { label: 'build:route-handlers', phase: 'Route handlers', schema: BUILD_SCHEMA }))

const routesVerifyPrompt = RULES + '\n\n' +
'TASK -- independently verify the Next.js chat route handlers from plan Step 5.\n\n' +
'What was claimed: ' + routesBuild.summary + '\n' + routesBuild.keyDetails + '\n\n' +
'Read src/app/api/chat/route.ts and src/app/api/chat/thread/route.ts in full (if either is missing, that is an automatic fail). Confirm: there is no remaining code path that returns an HTTP 200 with a hardcoded/fabricated "[Backend unavailable]"-style placeholder answer (grep the whole diff for "unavailable" and "placeholder" and read every hit); cookies() is awaited (this is Next 16, calling it without await is a real bug here); the user message is upserted before the backend fetch call; onError/onEnd (or onFinish) callbacks exist and do not leave an empty/placeholder assistant row on failure while still preserving any partial text that did stream. Run "npx tsc --noEmit" and "npm run lint" from the repo root and confirm both are clean (report exact command output if either fails). Report pass:true only if all of the above holds.'

const routesVerify = await agent(routesVerifyPrompt, { label: 'verify:route-handlers', phase: 'Route handlers', schema: VERIFY_SCHEMA })
log('Route handlers: ' + (routesVerify && routesVerify.pass ? 'pass' : 'FAIL'))

// ---------------------------------------------------------------------------
// Phase 4: client refactor (plan Step 6)
// ---------------------------------------------------------------------------

phase('Client refactor')

const clientBuildPrompt = RULES + '\n\n' +
'TASK -- client-side chat UI refactor (plan Step 6).\n\n' +
'Route contract you are consuming (from the agent who built the routes): ' + routesBuild.keyDetails + '\n' +
'Chat types/modules available: ' + modulesBuild.keyDetails + '\n\n' +
'Read the current src/components/chat/ChatPanel.tsx first (it is a small hand-rolled useState chat loop, ~130 lines, that POSTs to /api/chat and ignores sources entirely -- no citation UI exists today). Also read src/components/leads/LeadDetailPanel.tsx to see how it is invoked: <ChatPanel event={detail?.event ?? null} /> where event is StockEvent | null and event.id is a string. Also skim the existing ui/ primitives you will reuse: src/components/ui/card.tsx, scroll-area.tsx, skeleton.tsx, badge.tsx, button.tsx, input.tsx -- match their existing visual conventions (this app currently uses small 11px text, muted-foreground colors, rounded-lg bubbles for chat -- keep that look).\n\n' +
'Before writing useChat-based code, inspect node_modules/@ai-sdk/react\'s real type definitions/docs for the useChat hook\'s v6 API (message/parts shape, status values, stop(), regenerate(), sendMessage(), and whether input/handleSubmit are still managed by the hook or must be handled manually with local useState in this version) and node_modules/ai for DefaultChatTransport\'s options (api, prepareSendMessagesRequest) -- ground this against what is actually installed, not memory.\n\n' +
'Write:\n\n' +
'1. src/components/chat/ChatPanel.tsx (rewrite, ~110 lines): keep the outer Card/empty-state shell (renders a friendly empty state when event is null, matching the current look). When event is non-null, fetch GET /api/chat/thread?eventId=<event.id> in an effect keyed on event.id (show a Skeleton while loading), then render a new <ChatThread key={event.id} event={event} initialMessages={...} initialThreadId={...} /> -- the key={event.id} is load-bearing: it forces a full remount when the selected event changes, which is what fixes the existing stale-transcript bug where messages carried over between different events.\n\n' +
'2. src/components/chat/ChatThread.tsx (new, ~150 lines): use the useChat hook (generic over the ChatUIMessage type) with { id: event.id, messages: initialMessages, transport: new DefaultChatTransport({ api: "/api/chat", prepareSendMessagesRequest: <inject { eventId: event.id, threadId: currentThreadIdRef.current } into the request body> }), onData: <update a threadIdRef when a "data-thread" part arrives> }. Manage the text input with local useState and call sendMessage({ text }) yourself on submit (do not rely on the hook\'s own managed input/handleSubmit if this installed version does not provide/recommend it for v6 -- check what you found in node_modules). Render message.parts in order: a "text" part renders with the existing bubble styling (user right-aligned, assistant left-aligned, matching the current visual style you read above); a "data-sources" part renders a <SourceList sources={...} />; a native "source-url" part is not separately rendered (skip it, data-sources is the UI\'s source of truth, source-url exists only for SDK interop). When status is "submitted" show a small "Searching filings…" shimmer/loading row. When there is an error, show an inline destructive-styled row with a Retry button that calls regenerate(). Auto-scroll to the bottom as new parts stream in (a bottom sentinel div plus a scroll effect keyed on the messages array). Show a Stop button (calls the hook\'s stop()) in place of the send button while status is "streaming".\n\n' +
'3. src/components/chat/SourceList.tsx (new, ~70 lines): props = { sources: ChatSource[] }. A "Sources (N)" toggle that expands/collapses. Each source row: a "[n]" index matching the "[Source n]" numbering the backend LLM cites (1-based, in array order); the title as a link to url (fallback text "Untitled document" if title/url are null); source_name and a formatted published_at date; ticker Badge components (reuse the existing src/components/ui/badge.tsx) for each ticker; a similarity percentage; a muted excerpt line.\n\n' +
'4. In src/types/leads.ts, remove the now-dead ChatMessage interface (the one with fields id/role/content/createdAt, currently around lines 54-59). First grep the whole src/ tree for other imports of that type to confirm ChatPanel.tsx was its only consumer -- if anything else still imports it, do not remove it and explain why in your notes instead. Only remove that one interface -- the rest of that file has unrelated pre-existing local edits you must not touch.\n\n' +
'Run "npx tsc --noEmit" and "npm run lint" from the repo root afterward and fix any errors in the files you touched.\n\n' +
'Return the component prop shapes and file list in keyDetails.'

const clientBuild = safe(await agent(clientBuildPrompt, { label: 'build:client-refactor', phase: 'Client refactor', schema: BUILD_SCHEMA }))

const clientVerifyPrompt = RULES + '\n\n' +
'TASK -- independently verify the client chat UI refactor from plan Step 6.\n\n' +
'What was claimed: ' + clientBuild.summary + '\n' + clientBuild.keyDetails + '\n\n' +
'Confirm src/components/chat/ChatPanel.tsx, src/components/chat/ChatThread.tsx, and src/components/chat/SourceList.tsx all exist and read them (any missing file is an automatic fail). Confirm ChatPanel renders ChatThread with a key prop derived from the event id (grep for "key={" near the ChatThread usage). Confirm ChatThread has a Stop-button code path (references stop()) and a Retry/error code path (references regenerate() or similar). Confirm src/types/leads.ts no longer defines the old ChatMessage interface, and grep the whole src/ tree for "ChatMessage" to confirm nothing still imports the removed type from "@/types/leads" (a same-named type/import from the "ai" package or your own new chat types is fine, only the old leads.ts one should be gone). Run "npx tsc --noEmit" and "npm run lint" from the repo root and confirm both are clean. Report pass:true only if all of the above holds.'

const clientVerify = await agent(clientVerifyPrompt, { label: 'verify:client-refactor', phase: 'Client refactor', schema: VERIFY_SCHEMA })
log('Client refactor: ' + (clientVerify && clientVerify.pass ? 'pass' : 'FAIL'))

// ---------------------------------------------------------------------------
// Phase 5: verification -- automated end-to-end, then a browser UX smoke test
// ---------------------------------------------------------------------------

phase('Verification')

const e2eAutomatedPrompt = RULES + '\n\n' +
'TASK -- automated end-to-end verification of the whole streaming chat feature (plan Verification section), API-level only (a separate task after this one does a browser-driven pass).\n\n' +
'Everything below has already been built and individually verified: SQL migration + local env (' + fact(migrationOutcome).summary + '), FastAPI SSE endpoint (' + fact(backendOutcome).summary + '), frontend modules (' + modulesBuild.summary + '), Next.js route handlers (' + routesBuild.summary + '), client components (' + clientBuild.summary + '). Your job is to prove the whole chain works together, not to build anything.\n\n' +
'1. Corpus precheck: with the backend NOT yet running, first start it (backend/venv/bin/python3 -m uvicorn backend.main:app --port 8000, backgrounded with nohup + a log file, brief sleep to let it boot), then curl http://localhost:8000/api/ingestion/status and note the embedded document/chunk counts. Do NOT trigger any new scrape/embed/ingestion batch yourself (that costs real API calls/time and is out of scope) -- just note the corpus size honestly; if it is tiny, expect most test queries to hit the empty-retrieval canned-answer path rather than returning real citations, and treat that as an acceptable pass for plumbing purposes as long as the canned-answer path itself works correctly.\n\n' +
'2. With the backend still running, start Next in the background too (npm run dev, backgrounded with nohup + a log file, wait for it to report ready on port 3000). Then, from a shell (not a browser), exercise the full path through the Next adapter (not directly against the backend this time): first GET http://localhost:3000/api/chat/thread?eventId=1 and save the Set-Cookie header (sl_anon_session) -- confirm it is httpOnly. Then POST http://localhost:3000/api/chat re-sending that cookie, with a body shaped like { id: "test-1", messages: [{ role: "user", parts: [{ type: "text", text: "What securities lawsuits are in the database?" }] }], eventId: "1", threadId: null } (adjust field names/shapes if the actual route contract the prior agents reported differs -- read src/app/api/chat/route.ts yourself to get the exact expected body shape right rather than guessing) -- confirm you get back a streaming text/event-stream-ish UI message stream response (curl -N to see it arrive incrementally) rather than a single buffered JSON blob, and that it is not a fabricated "[Backend unavailable]" placeholder string.\n\n' +
'3. Query the local Supabase REST API directly (using the SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local, as a header apikey + Authorization: Bearer) for the chat_threads and chat_messages tables and confirm a thread row was created for eventId "1" and at least a user message row exists (and an assistant row too, once the earlier POST\'s stream has finished -- you may need to wait briefly / poll).\n\n' +
'4. Run, from the repo root: "npx tsc --noEmit", "npm run lint", and "npm run build" (a full production build) -- all three must be clean/succeed.\n\n' +
'5. Kill both background processes (Next dev server and uvicorn) when you are done, regardless of outcome, so no orphaned dev servers are left occupying ports 3000/8000.\n\n' +
'Return pass:true only if steps 2-4 all succeeded (step 1 is informational, its outcome does not gate pass/fail unless it reveals the retrieval RPC itself is broken). Put the corpus size, and anything a human reviewer should double check, in notes.'

const e2eAutomated = await agent(e2eAutomatedPrompt, { label: 'verify:e2e-automated', phase: 'Verification', schema: VERIFY_SCHEMA })
log('Automated e2e: ' + (e2eAutomated && e2eAutomated.pass ? 'pass' : 'FAIL'))

const browserSmokePrompt = RULES + '\n\n' +
'TASK -- browser-driven UX smoke test of the streaming chat feature (plan Verification section, "End-to-end (npm run dev)" checklist), using the mcp__claude-in-chrome__* tools.\n\n' +
'The feature under test: a chat panel on a lead/event detail page that now streams tokens live (instead of a single buffered reply), shows a Sources panel with citation links, and persists conversation history per event so it survives a reload. Route contract: ' + routesBuild.keyDetails + '\n\n' +
'Setup: from the repo root, start both dev servers in the background if they are not already running from a prior step (backend/venv/bin/python3 -m uvicorn backend.main:app --port 8000, and npm run dev for Next on port 3000; nohup + log files; wait for both to report ready). Load the local Chrome tab tools first (tabs_context_mcp, navigate, computer, read_page, tabs_create_mcp) via ToolSearch if they are not already available to you.\n\n' +
'Drive the browser: navigate to http://localhost:3000, find the leads list, open any one lead\'s detail view so its Chat panel is visible, type a research question into the chat input and submit it. Observe and report on each of these, as best you can tell from the live page and the browser network/console tools:\n' +
'  - The assistant reply visibly appears incrementally (streaming), not all at once.\n' +
'  - A Sources section appears (or, if the corpus is too small and this query hit the empty-retrieval canned-answer path, that a sensible canned answer appeared instead of an error or a placeholder string).\n' +
'  - The chat auto-scrolls to keep the newest content visible while it streams.\n' +
'  - A Stop control is visible while streaming, and the input/send control is disabled or swapped appropriately mid-stream.\n' +
'  - Reload the page (hard reload) and confirm the same conversation transcript (and any sources) reappears rather than resetting to empty -- this proves persistence/resume works.\n' +
'  - If there is more than one lead available, switch to a different lead\'s detail view and confirm the chat panel shows an empty/fresh transcript for that different lead (not the previous one\'s messages), then switch back to the first lead and confirm its transcript is still intact -- this proves per-event thread isolation.\n' +
'  - Kill the backend uvicorn process while a request is NOT in flight, then submit another chat message: confirm an inline error state with a Retry appears rather than a fake success message; restart uvicorn and click Retry, confirm it recovers.\n\n' +
'When you are done, kill any background dev server processes you started. Report pass:true only if the streaming behavior, sources/canned-answer behavior, persistence-on-reload, and the error/Retry path all worked; note anything that could not be tested (e.g. the browser tools were unavailable, or the corpus was empty) rather than silently skipping it.'

const browserSmoke = await agent(browserSmokePrompt, { label: 'verify:browser-smoke', phase: 'Verification', schema: VERIFY_SCHEMA })
log('Browser smoke test: ' + (browserSmoke && browserSmoke.pass ? 'pass' : 'FAIL'))

return {
  foundations,
  modules: { build: modulesBuild, verify: modulesVerify },
  routes: { build: routesBuild, verify: routesVerify },
  client: { build: clientBuild, verify: clientVerify },
  e2eAutomated,
  browserSmoke,
}
