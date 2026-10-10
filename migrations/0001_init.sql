-- Edge · Supabase Postgres. Un seul serveur => guild_id porté mais rarement filtré.
CREATE TABLE IF NOT EXISTS members (
  user_id BIGINT PRIMARY KEY,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  xp INT NOT NULL DEFAULT 0,
  messages INT NOT NULL DEFAULT 0,
  voice_minutes INT NOT NULL DEFAULT 0,
  warn_points INT NOT NULL DEFAULT 0,
  last_hash TEXT,
  rules_accepted_at TIMESTAMPTZ,
  presented_at TIMESTAMPTZ,
  verified BOOLEAN NOT NULL DEFAULT false,
  flags JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS cases (
  id BIGSERIAL PRIMARY KEY,           -- fait office de numéro de dossier (#id)
  user_id BIGINT NOT NULL,
  moderator_id BIGINT NOT NULL,
  type TEXT NOT NULL,
  reason TEXT,
  duration_minutes INT,
  dm_sent BOOLEAN NOT NULL DEFAULT false,
  evidence_url TEXT,
  message_url TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  ticket_id BIGINT
);
CREATE INDEX IF NOT EXISTS cases_user_idx ON cases (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tickets (
  id BIGSERIAL PRIMARY KEY,           -- => ticket-0042
  channel_id BIGINT UNIQUE NOT NULL,
  opener_id BIGINT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | claimed | pending_staff | closed
  pinged_role TEXT,
  claimed_by BIGINT,
  intro TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  close_reason TEXT,
  closed_by TEXT,                       -- pseudo de qui a fermé (libre, pas un snowflake)
  transcript_url TEXT,
  pinged_after BOOLEAN NOT NULL DEFAULT false,
  last_message_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS tickets_open_idx ON tickets (opener_id) WHERE status <> 'closed';

CREATE TABLE IF NOT EXISTS ticket_messages (
  id BIGSERIAL PRIMARY KEY,
  ticket_id BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id BIGINT NOT NULL,
  author_name TEXT,
  content TEXT,
  attachments JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ticket_messages_ticket_idx ON ticket_messages (ticket_id, id);

CREATE TABLE IF NOT EXISTS giveaways (
  id BIGSERIAL PRIMARY KEY,
  message_id BIGINT,
  channel_id BIGINT NOT NULL,
  host_id BIGINT NOT NULL,
  prize TEXT NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  winners_count INT NOT NULL DEFAULT 1,
  requires_roles JSONB NOT NULL DEFAULT '[]',
  min_days SMALLINT NOT NULL DEFAULT 0,
  weights JSONB NOT NULL DEFAULT '{}',
  ping BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'running',  -- running | ended | cancelled
  ended_at TIMESTAMPTZ,
  winner_ids JSONB NOT NULL DEFAULT '[]',
  reroll_of BIGINT
);

CREATE TABLE IF NOT EXISTS giveaway_entries (
  id BIGSERIAL PRIMARY KEY,
  giveaway_id BIGINT NOT NULL REFERENCES giveaways(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  weight NUMERIC(6,3) NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (giveaway_id, user_id)
);

CREATE TABLE IF NOT EXISTS polls (
  id BIGSERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL,
  channel_id BIGINT NOT NULL,
  author_id BIGINT NOT NULL,
  question TEXT NOT NULL,
  ends_at TIMESTAMPTZ,
  closed BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS reports (
  id BIGSERIAL PRIMARY KEY,
  reporter_id BIGINT NOT NULL,
  target_user_id BIGINT,
  target_message_id BIGINT,
  link TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  ticket_id BIGINT,
  founded BOOLEAN,
  reviewed_by BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS automod_rules (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  params JSONB NOT NULL DEFAULT '{}',
  action TEXT NOT NULL DEFAULT 'log',
  strikes INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS automod_hits (
  id BIGSERIAL PRIMARY KEY,
  rule_kind TEXT NOT NULL,
  user_id BIGINT NOT NULL,
  message_id BIGINT,
  channel_id BIGINT,
  detail TEXT,
  action_taken TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS partnerships (
  id BIGSERIAL PRIMARY KEY,
  partner_name TEXT NOT NULL,
  partner_guild_id BIGINT,
  contact_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | active | paused | expired
  reciprocal BOOLEAN NOT NULL DEFAULT false,
  member_count INT,
  invite_code TEXT,
  fails INT NOT NULL DEFAULT 0,
  checks INT NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT
);

CREATE TABLE IF NOT EXISTS applications (
  id BIGSERIAL PRIMARY KEY,
  role_requested TEXT NOT NULL,
  applicant_id BIGINT NOT NULL,
  answers JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'received', -- received | interview | accepted | rejected
  reviewed_by BIGINT,
  decided_at TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invite_stats (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  code TEXT NOT NULL,
  used INT NOT NULL DEFAULT 0,
  month TEXT NOT NULL,
  UNIQUE (user_id, code, month)
);

CREATE TABLE IF NOT EXISTS suggestions (
  id BIGSERIAL PRIMARY KEY,
  message_id BIGINT NOT NULL,
  thread_id BIGINT,
  author_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'recu',      -- recu | a_etudier | valide | refuse
  staff_note TEXT,
  reviewed_by BIGINT,
  votes_up INT NOT NULL DEFAULT 0,
  votes_down INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduled_events (
  id BIGSERIAL PRIMARY KEY,
  guild_event_id BIGINT,
  channel_id BIGINT NOT NULL,
  creator_id BIGINT NOT NULL,
  title TEXT NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  reminded BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS events_rsvp (
  id BIGSERIAL PRIMARY KEY,
  event_row BIGINT NOT NULL REFERENCES scheduled_events(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  state TEXT NOT NULL,
  UNIQUE (event_row, user_id)
);

CREATE TABLE IF NOT EXISTS level_rewards (id BIGSERIAL PRIMARY KEY, level INT NOT NULL UNIQUE, role_id BIGINT NOT NULL);

CREATE TABLE IF NOT EXISTS selfroles_state (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  role_key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_key)
);

CREATE TABLE IF NOT EXISTS presentations (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL,
  message_id BIGINT,
  answers JSONB NOT NULL DEFAULT '{}',
  verified BOOLEAN NOT NULL DEFAULT false,
  verified_by BIGINT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scheduler_jobs (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_key TEXT NOT NULL,
  run_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  locked_by TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  attempts INT NOT NULL DEFAULT 0,
  done_at TIMESTAMPTZ,
  last_error TEXT,
  UNIQUE (kind, ref_key)
);
CREATE INDEX IF NOT EXISTS scheduler_due_idx ON scheduler_jobs (run_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS bot_events (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Annonces planifiees (module announcements). Oubliee dans la premiere version du schema : le
-- module ecrivait ici, PostgREST/Postgres repondait « relation does not exist », et en memoire
-- (dry-run) tout marchait. D'ou le test `npm test` « le code ne touche aucune table absente ».
CREATE TABLE IF NOT EXISTS announcements (
  id BIGSERIAL PRIMARY KEY,
  channel_id BIGINT NOT NULL,
  author_id BIGINT NOT NULL,
  embed JSONB NOT NULL DEFAULT '{}',    -- { title, body, ping }
  scheduled_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,             -- NULL = en attente de publication
  message_id BIGINT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS announcements_pending_idx ON announcements (scheduled_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS flags (key TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
