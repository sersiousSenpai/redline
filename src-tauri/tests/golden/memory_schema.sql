-- Memory schema golden: every sqlite_master row of the Polis lake + catalog
-- tables from a fresh in-memory Database, in creation order.
-- Regenerate: UPDATE_GOLDEN=1 cargo test --test schema_golden

-- table prompts (prompts)
CREATE TABLE prompts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                source TEXT NOT NULL,
                origin TEXT NOT NULL DEFAULT 'redline',
                surface TEXT NOT NULL,
                role TEXT,
                session_id TEXT,
                claude_session_id TEXT,
                mission_id TEXT,
                project_path TEXT,
                body TEXT NOT NULL,
                body_hash TEXT NOT NULL
            , gist TEXT, compacted_at INTEGER, original_bytes INTEGER, user_text TEXT, gist_source TEXT, principal_id TEXT, device_id TEXT, agent_id TEXT, run_id TEXT, org_id TEXT, visibility TEXT NOT NULL DEFAULT 'private', fts_text TEXT GENERATED ALWAYS AS (
                    CASE WHEN role = 'agent'  THEN COALESCE(NULLIF(user_text, ''), '')
                         WHEN role = 'system' THEN substr(COALESCE(NULLIF(body, ''), gist, ''),
                                                          1, 600)
                         ELSE COALESCE(NULLIF(body, ''), gist, '') END) VIRTUAL, fts_head TEXT
                GENERATED ALWAYS AS (substr(fts_text, 1, 400)) VIRTUAL, fts_tail TEXT
                GENERATED ALWAYS AS (substr(fts_text, 401)) VIRTUAL, thread_kind TEXT, thread_id TEXT, parent_session_id TEXT, model TEXT, model_source TEXT);

-- index idx_prompts_dedup (prompts)
CREATE UNIQUE INDEX idx_prompts_dedup
                ON prompts (body_hash, claude_session_id);

-- table ledger_events (ledger_events)
CREATE TABLE ledger_events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                kind TEXT NOT NULL,
                author TEXT NOT NULL,
                prompt_id INTEGER,
                session_id TEXT,
                version_number INTEGER,
                ref_kind TEXT,
                ref_id TEXT,
                payload_hash TEXT NOT NULL,
                prev_hash TEXT NOT NULL,
                entry_hash TEXT NOT NULL
            );

-- index idx_ledger_kind (ledger_events)
CREATE INDEX idx_ledger_kind ON ledger_events (kind);

-- index idx_ledger_ref (ledger_events)
CREATE INDEX idx_ledger_ref ON ledger_events (ref_kind, ref_id);

-- table class_nodes (class_nodes)
CREATE TABLE class_nodes (
                id TEXT PRIMARY KEY,
                parent_id TEXT,               -- NULL = a root (a class)
                kind TEXT NOT NULL DEFAULT 'node',   -- node | digest
                title TEXT NOT NULL,
                summary TEXT,                 -- digest gist; NULL for plain nodes
                project_path TEXT,            -- optional binding on any node
                ip_name TEXT,                 -- whose plan it was (provenance)
                status TEXT NOT NULL DEFAULT 'proposed',  -- proposed | accepted
                pinned INTEGER NOT NULL DEFAULT 0,        -- anti-decay marker
                curated_by TEXT,              -- 'classifier' | author on accept
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            , retired_by_run INTEGER, retired_into TEXT, principal_id TEXT, device_id TEXT, agent_id TEXT, run_id TEXT, org_id TEXT, visibility TEXT NOT NULL DEFAULT 'private');

-- index sqlite_autoindex_class_nodes_1 (class_nodes) [auto]

-- index idx_class_nodes_parent (class_nodes)
CREATE INDEX idx_class_nodes_parent ON class_nodes (parent_id);

-- index idx_class_nodes_status (class_nodes)
CREATE INDEX idx_class_nodes_status ON class_nodes (status);

-- table class_links (class_links)
CREATE TABLE class_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id TEXT NOT NULL,
                target_kind TEXT NOT NULL,
                target_id TEXT NOT NULL,
                note TEXT,
                status TEXT NOT NULL DEFAULT 'proposed',  -- proposed | accepted
                created_at INTEGER NOT NULL
            , retired_by_run INTEGER);

-- index idx_class_links_node (class_links)
CREATE INDEX idx_class_links_node ON class_links (node_id);

-- index idx_class_links_dedup (class_links)
CREATE UNIQUE INDEX idx_class_links_dedup
                ON class_links (node_id, target_kind, target_id);

-- table class_proposals (class_proposals)
CREATE TABLE class_proposals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id INTEGER,
                op TEXT NOT NULL,             -- promote | split | merge | collapse
                node_id TEXT,                 -- primary subject node
                parent_id TEXT,               -- new parent (promote) / merge target parent
                title TEXT,                   -- merge target / collapse digest title
                summary TEXT,                 -- collapse digest gist
                extra_json TEXT,              -- op-specific payload (split parts, merge ids, cite seqs)
                rationale TEXT,               -- agent's stated why (size/recency/coherence)
                status TEXT NOT NULL DEFAULT 'proposed',
                created_at INTEGER NOT NULL
            );

-- index idx_class_proposals_status (class_proposals)
CREATE INDEX idx_class_proposals_status ON class_proposals (status);

-- table class_runs (class_runs)
CREATE TABLE class_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                started_at INTEGER NOT NULL,
                finished_at INTEGER,
                status TEXT NOT NULL,         -- running | done | error
                seq_from INTEGER,
                seq_to INTEGER,
                claude_session_id TEXT,
                summary TEXT
            , duration_ms INTEGER, items INTEGER, ops INTEGER, model TEXT, outcome TEXT, canary_before REAL, canary_after REAL, error TEXT, mode TEXT, llm_calls INTEGER, prompt_bytes INTEGER, tokens_in INTEGER, tokens_out INTEGER, wall_ms INTEGER, canary_json TEXT);

-- table supersessions (supersessions)
CREATE TABLE supersessions (
                old_seq INTEGER PRIMARY KEY,  -- the superseded decision event
                new_seq INTEGER NOT NULL,     -- the superseding decision event
                event_seq INTEGER NOT NULL,   -- the supersede ledger event
                created_at INTEGER NOT NULL
            );

-- index idx_supersessions_new (supersessions)
CREATE INDEX idx_supersessions_new
                ON supersessions (new_seq);

-- table user_notes (user_notes)
CREATE TABLE user_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                seq INTEGER,                  -- latest `note` ledger event seq
                target_kind TEXT NOT NULL,    -- ledger_event | class_node | session | none
                target_id TEXT,               -- event seq / node id / session id; NULL when standalone
                text TEXT NOT NULL DEFAULT '',
                starred INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            , principal_id TEXT, device_id TEXT, agent_id TEXT, run_id TEXT, org_id TEXT, visibility TEXT NOT NULL DEFAULT 'private');

-- index idx_user_notes_target (user_notes)
CREATE UNIQUE INDEX idx_user_notes_target
                ON user_notes (target_kind, target_id) WHERE target_kind <> 'none';

-- index idx_user_notes_starred (user_notes)
CREATE INDEX idx_user_notes_starred
                ON user_notes (starred, updated_at);

-- table class_observations (class_observations)
CREATE TABLE class_observations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                node_id TEXT NOT NULL,
                summary TEXT NOT NULL,
                cite_seqs TEXT NOT NULL,      -- JSON array of ledger seqs
                created_seq INTEGER,          -- the observation ledger event seq
                pinned INTEGER NOT NULL DEFAULT 0,
                dismissed INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            , retired_by_run INTEGER, principal_id TEXT, device_id TEXT, agent_id TEXT, run_id TEXT, org_id TEXT, visibility TEXT NOT NULL DEFAULT 'private');

-- index idx_class_observations_node (class_observations)
CREATE INDEX idx_class_observations_node
                ON class_observations (node_id, dismissed);

-- table plan_exports (plan_exports)
CREATE TABLE plan_exports (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                scope TEXT NOT NULL,          -- session | mission | class | full
                head_hash TEXT,
                exported_at INTEGER NOT NULL
            );

-- index idx_plan_exports_session (plan_exports)
CREATE UNIQUE INDEX idx_plan_exports_session
                ON plan_exports (session_id, scope);

-- table browse_events (browse_events)
CREATE TABLE browse_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                action TEXT NOT NULL,          -- verb vocabulary: 'navigate' | 'select' | 'submit' | 'leave'
                                              -- (enforced by ledger::BrowseAction, not a CHECK — additive widening)
                browse_id TEXT,               -- the tab's discussion-thread key
                url TEXT NOT NULL,
                title TEXT,
                text TEXT NOT NULL,           -- normalized page content (for P3 FTS)
                context_hash TEXT NOT NULL,   -- body_hash over `text`
                from_event_id INTEGER         -- trail edge: preceding browse_events.id (NULL = trail root)
            , shot_key TEXT, caption TEXT, principal_id TEXT, device_id TEXT, agent_id TEXT, run_id TEXT, org_id TEXT, visibility TEXT NOT NULL DEFAULT 'private');

-- index idx_browse_events_hash (browse_events)
CREATE INDEX idx_browse_events_hash ON browse_events (context_hash);

-- index idx_browse_events_tab (browse_events)
CREATE INDEX idx_browse_events_tab ON browse_events (browse_id);

-- table session_tree (session_tree)
CREATE TABLE session_tree (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                child_kind TEXT NOT NULL,
                child_id TEXT NOT NULL,
                parent_kind TEXT NOT NULL,
                parent_id TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

-- index idx_session_tree_child (session_tree)
CREATE UNIQUE INDEX idx_session_tree_child
                ON session_tree (child_kind, child_id);

-- index idx_session_tree_parent (session_tree)
CREATE INDEX idx_session_tree_parent
                ON session_tree (parent_kind, parent_id);

-- index idx_class_links_target (class_links)
CREATE INDEX idx_class_links_target
                ON class_links (target_kind, target_id, status);

-- index idx_ledger_prompt (ledger_events)
CREATE INDEX idx_ledger_prompt ON ledger_events (prompt_id);

-- index idx_ledger_session (ledger_events)
CREATE INDEX idx_ledger_session ON ledger_events (session_id);

-- index idx_ledger_ts (ledger_events)
CREATE INDEX idx_ledger_ts ON ledger_events (ts);

-- index idx_user_notes_target_all (user_notes)
CREATE INDEX idx_user_notes_target_all
                ON user_notes (target_kind, target_id);

-- index idx_supersessions_old (supersessions)
CREATE INDEX idx_supersessions_old
                ON supersessions (old_seq);

-- index idx_prompts_compacted (prompts)
CREATE INDEX idx_prompts_compacted
                ON prompts (compacted_at) WHERE gist IS NOT NULL;

-- index idx_prompts_ts (prompts)
CREATE INDEX idx_prompts_ts ON prompts (ts);

-- index idx_prompts_role (prompts)
CREATE INDEX idx_prompts_role ON prompts (role);

-- index idx_prompts_surface_ts (prompts)
CREATE INDEX idx_prompts_surface_ts ON prompts (surface, ts);

-- index idx_prompts_project_ts (prompts)
CREATE INDEX idx_prompts_project_ts ON prompts (project_path, ts);

-- index idx_prompts_session (prompts)
CREATE INDEX idx_prompts_session ON prompts (session_id);

-- index idx_prompts_claude_sess (prompts)
CREATE INDEX idx_prompts_claude_sess ON prompts (claude_session_id);

-- table prompt_archive (prompt_archive)
CREATE TABLE prompt_archive (
                prompt_id INTEGER PRIMARY KEY,
                body_hash TEXT NOT NULL,
                algo TEXT NOT NULL,
                original_bytes INTEGER NOT NULL,
                blob BLOB NOT NULL,
                archived_at INTEGER NOT NULL
            );

-- index idx_browse_events_shot (browse_events)
CREATE INDEX idx_browse_events_shot ON browse_events (shot_key);

-- index idx_class_nodes_retired (class_nodes)
CREATE INDEX idx_class_nodes_retired ON class_nodes (retired_by_run);

-- index idx_class_links_retired (class_links)
CREATE INDEX idx_class_links_retired ON class_links (retired_by_run);

-- table class_run_ops (class_run_ops)
CREATE TABLE class_run_ops (
                run_id INTEGER NOT NULL,
                op_ix INTEGER NOT NULL,
                op TEXT NOT NULL,             -- file | create | promote | split | merge | collapse | supersede | compact | observe
                subject_ids TEXT NOT NULL,    -- JSON array: node:<id> link:<id> obs:<id> prompt:<id> seq:<n>
                outcome TEXT NOT NULL,        -- applied | refused | expired | reverted
                reason TEXT,
                pre_image BLOB,               -- deflate(JSON), NULL once vacuumed
                pre_hash TEXT,
                post_image BLOB,
                ledger_seq INTEGER,
                reverted_by_run INTEGER,
                PRIMARY KEY (run_id, op_ix)
            );

-- index sqlite_autoindex_class_run_ops_1 (class_run_ops) [auto]

-- table principals (principals)
CREATE TABLE principals (
                principal_id TEXT PRIMARY KEY,   -- hex(sha256(pubkey)) or a derived id
                kind TEXT NOT NULL,              -- human | device | agent | org
                pubkey TEXT,                     -- hex; keyed principals only
                parent_id TEXT,                  -- device → human, agent → device
                display_name TEXT,
                created_at INTEGER NOT NULL
            );

-- index sqlite_autoindex_principals_1 (principals) [auto]

-- index idx_principals_parent (principals)
CREATE INDEX idx_principals_parent ON principals (parent_id);

-- table principal_aliases (principal_aliases)
CREATE TABLE principal_aliases (
                alias TEXT PRIMARY KEY,          -- a legacy author string
                principal_id TEXT NOT NULL
            );

-- index sqlite_autoindex_principal_aliases_1 (principal_aliases) [auto]

-- index idx_prompts_scope (prompts)
CREATE INDEX idx_prompts_scope ON prompts (principal_id, org_id, project_path);

-- index idx_class_nodes_scope (class_nodes)
CREATE INDEX idx_class_nodes_scope ON class_nodes (principal_id, org_id, project_path);

-- index idx_browse_events_scope (browse_events)
CREATE INDEX idx_browse_events_scope ON browse_events (principal_id, org_id);

-- index idx_user_notes_scope (user_notes)
CREATE INDEX idx_user_notes_scope ON user_notes (principal_id, org_id);

-- index idx_class_observations_scope (class_observations)
CREATE INDEX idx_class_observations_scope ON class_observations (principal_id, org_id);

-- table embeddings (embeddings)
CREATE TABLE embeddings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                target_kind TEXT NOT NULL,       -- prompt | browse_event | class_node
                target_id INTEGER NOT NULL,
                chunk_ix INTEGER NOT NULL,
                char_start INTEGER NOT NULL,
                char_len INTEGER NOT NULL,
                dim INTEGER NOT NULL,
                scale REAL NOT NULL,
                vec BLOB NOT NULL,
                model TEXT NOT NULL,
                source_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );

-- index idx_embeddings_chunk (embeddings)
CREATE UNIQUE INDEX idx_embeddings_chunk
                ON embeddings (target_kind, target_id, chunk_ix, model);

-- index idx_embeddings_target (embeddings)
CREATE INDEX idx_embeddings_target
                ON embeddings (target_kind, target_id);

-- table prompts_fts (prompts_fts)
CREATE VIRTUAL TABLE prompts_fts USING fts5(
                        fts_head, fts_tail,
                        content='prompts', content_rowid='id',
                        tokenize='porter unicode61 remove_diacritics 2 tokenchars ''_-./@''', prefix='2 3'
                    );

-- table prompts_fts_data (prompts_fts_data)
CREATE TABLE 'prompts_fts_data'(id INTEGER PRIMARY KEY, block BLOB);

-- table prompts_fts_idx (prompts_fts_idx)
CREATE TABLE 'prompts_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;

-- table prompts_fts_docsize (prompts_fts_docsize)
CREATE TABLE 'prompts_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);

-- table prompts_fts_config (prompts_fts_config)
CREATE TABLE 'prompts_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;

-- trigger prompts_fts_ai (prompts)
CREATE TRIGGER prompts_fts_ai AFTER INSERT ON prompts BEGIN
                        INSERT INTO prompts_fts (rowid, fts_head, fts_tail)
                        VALUES (new.id, new.fts_head, new.fts_tail);
                    END;

-- trigger prompts_fts_ad (prompts)
CREATE TRIGGER prompts_fts_ad AFTER DELETE ON prompts BEGIN
                        INSERT INTO prompts_fts (prompts_fts, rowid, fts_head, fts_tail)
                        VALUES ('delete', old.id, old.fts_head, old.fts_tail);
                    END;

-- trigger prompts_fts_au (prompts)
CREATE TRIGGER prompts_fts_au AFTER UPDATE ON prompts BEGIN
                        INSERT INTO prompts_fts (prompts_fts, rowid, fts_head, fts_tail)
                        VALUES ('delete', old.id, old.fts_head, old.fts_tail);
                        INSERT INTO prompts_fts (rowid, fts_head, fts_tail)
                        VALUES (new.id, new.fts_head, new.fts_tail);
                    END;

-- table browse_events_fts (browse_events_fts)
CREATE VIRTUAL TABLE browse_events_fts USING fts5(
                        title, url, text,
                        content='browse_events', content_rowid='id',
                        tokenize='porter unicode61 remove_diacritics 2 tokenchars ''_-./@'''
                    );

-- table browse_events_fts_data (browse_events_fts_data)
CREATE TABLE 'browse_events_fts_data'(id INTEGER PRIMARY KEY, block BLOB);

-- table browse_events_fts_idx (browse_events_fts_idx)
CREATE TABLE 'browse_events_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;

-- table browse_events_fts_docsize (browse_events_fts_docsize)
CREATE TABLE 'browse_events_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);

-- table browse_events_fts_config (browse_events_fts_config)
CREATE TABLE 'browse_events_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;

-- trigger browse_events_ai (browse_events)
CREATE TRIGGER browse_events_ai AFTER INSERT ON browse_events BEGIN
                        INSERT INTO browse_events_fts (rowid, title, url, text)
                        VALUES (new.id, new.title, new.url, new.text);
                    END;

-- trigger browse_events_ad (browse_events)
CREATE TRIGGER browse_events_ad AFTER DELETE ON browse_events BEGIN
                        INSERT INTO browse_events_fts (browse_events_fts, rowid, title, url, text)
                        VALUES ('delete', old.id, old.title, old.url, old.text);
                    END;

-- trigger browse_events_au (browse_events)
CREATE TRIGGER browse_events_au AFTER UPDATE ON browse_events BEGIN
                        INSERT INTO browse_events_fts (browse_events_fts, rowid, title, url, text)
                        VALUES ('delete', old.id, old.title, old.url, old.text);
                        INSERT INTO browse_events_fts (rowid, title, url, text)
                        VALUES (new.id, new.title, new.url, new.text);
                    END;

-- table class_nodes_fts (class_nodes_fts)
CREATE VIRTUAL TABLE class_nodes_fts USING fts5(
                        title, summary,
                        content='class_nodes', content_rowid='rowid',
                        tokenize='porter unicode61 remove_diacritics 2 tokenchars ''_-./@''', prefix='2 3'
                    );

-- table class_nodes_fts_data (class_nodes_fts_data)
CREATE TABLE 'class_nodes_fts_data'(id INTEGER PRIMARY KEY, block BLOB);

-- table class_nodes_fts_idx (class_nodes_fts_idx)
CREATE TABLE 'class_nodes_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;

-- table class_nodes_fts_docsize (class_nodes_fts_docsize)
CREATE TABLE 'class_nodes_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);

-- table class_nodes_fts_config (class_nodes_fts_config)
CREATE TABLE 'class_nodes_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;

-- trigger class_nodes_fts_ai (class_nodes)
CREATE TRIGGER class_nodes_fts_ai AFTER INSERT ON class_nodes BEGIN
                        INSERT INTO class_nodes_fts (rowid, title, summary)
                        VALUES (new.rowid, new.title, COALESCE(new.summary, ''));
                    END;

-- trigger class_nodes_fts_ad (class_nodes)
CREATE TRIGGER class_nodes_fts_ad AFTER DELETE ON class_nodes BEGIN
                        INSERT INTO class_nodes_fts (class_nodes_fts, rowid, title, summary)
                        VALUES ('delete', old.rowid, old.title, COALESCE(old.summary, ''));
                    END;

-- trigger class_nodes_fts_au (class_nodes)
CREATE TRIGGER class_nodes_fts_au AFTER UPDATE ON class_nodes BEGIN
                        INSERT INTO class_nodes_fts (class_nodes_fts, rowid, title, summary)
                        VALUES ('delete', old.rowid, old.title, COALESCE(old.summary, ''));
                        INSERT INTO class_nodes_fts (rowid, title, summary)
                        VALUES (new.rowid, new.title, COALESCE(new.summary, ''));
                    END;

-- table prompts_grep (prompts_grep)
CREATE VIRTUAL TABLE prompts_grep USING fts5(
                        fts_text, content='prompts', content_rowid='id',
                        tokenize='trigram'
                    );

-- table prompts_grep_data (prompts_grep_data)
CREATE TABLE 'prompts_grep_data'(id INTEGER PRIMARY KEY, block BLOB);

-- table prompts_grep_idx (prompts_grep_idx)
CREATE TABLE 'prompts_grep_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;

-- table prompts_grep_docsize (prompts_grep_docsize)
CREATE TABLE 'prompts_grep_docsize'(id INTEGER PRIMARY KEY, sz BLOB);

-- table prompts_grep_config (prompts_grep_config)
CREATE TABLE 'prompts_grep_config'(k PRIMARY KEY, v) WITHOUT ROWID;

-- trigger prompts_grep_ai (prompts)
CREATE TRIGGER prompts_grep_ai AFTER INSERT ON prompts BEGIN
                        INSERT INTO prompts_grep (rowid, fts_text) VALUES (new.id, new.fts_text);
                    END;

-- trigger prompts_grep_ad (prompts)
CREATE TRIGGER prompts_grep_ad AFTER DELETE ON prompts BEGIN
                        INSERT INTO prompts_grep (prompts_grep, rowid, fts_text)
                        VALUES ('delete', old.id, old.fts_text);
                    END;

-- trigger prompts_grep_au (prompts)
CREATE TRIGGER prompts_grep_au AFTER UPDATE ON prompts BEGIN
                        INSERT INTO prompts_grep (prompts_grep, rowid, fts_text)
                        VALUES ('delete', old.id, old.fts_text);
                        INSERT INTO prompts_grep (rowid, fts_text) VALUES (new.id, new.fts_text);
                    END;

-- table browse_grep (browse_grep)
CREATE VIRTUAL TABLE browse_grep USING fts5(
                        url, title, content='browse_events', content_rowid='id',
                        tokenize='trigram'
                    );

-- table browse_grep_data (browse_grep_data)
CREATE TABLE 'browse_grep_data'(id INTEGER PRIMARY KEY, block BLOB);

-- table browse_grep_idx (browse_grep_idx)
CREATE TABLE 'browse_grep_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;

-- table browse_grep_docsize (browse_grep_docsize)
CREATE TABLE 'browse_grep_docsize'(id INTEGER PRIMARY KEY, sz BLOB);

-- table browse_grep_config (browse_grep_config)
CREATE TABLE 'browse_grep_config'(k PRIMARY KEY, v) WITHOUT ROWID;

-- trigger browse_grep_ai (browse_events)
CREATE TRIGGER browse_grep_ai AFTER INSERT ON browse_events BEGIN
                        INSERT INTO browse_grep (rowid, url, title)
                        VALUES (new.id, new.url, COALESCE(new.title, ''));
                    END;

