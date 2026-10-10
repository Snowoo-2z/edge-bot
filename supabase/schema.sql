-- ============================================================================
-- EDGE · schéma complet, à coller dans Supabase :
--   Project → SQL Editor → New query → coller → Run
--
-- · Idempotent : tu peux le relancer après chaque mise à jour, il ne détruit RIEN
--   (CREATE ... IF NOT EXISTS partout, aucune DROP, aucun TRUNCATE).
-- · Il crée 23 tables, les index et 3 fonctions que Edge appelle par
--   l'API : edge_schema_check, edge_prune_events, edge_counts.
-- · Après ce fichier, Edge n'a besoin que de SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY : il
--   passe par l'API HTTP de Supabase, donc JAMAIS le mot de passe de la base ni un pooler.
-- · Généré par « npm run db:sql » à partir de migrations/*.sql — ne pas éditer à la main.
-- ============================================================================

SET search_path = public;

-- ---- 0001_init.sql ----
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
  transcript_url TEXT,
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

CREATE TABLE IF NOT EXISTS flags (key TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());

-- ---- 0002_edge_functions.sql ----
-- Edge · fonctions appelees par l'API PostgREST (/rest/v1/rpc/<nom>).
-- Le mode « API Supabase » ne peut pas envoyer de SQL brut : toute agregation, tout menage et
-- tout diagnostic passent par une fonction declaree ici. Elles sont CREES OU REMPLACEES, donc ce
-- fichier est sur a relancer apres chaque mise a jour (supabase/schema.sql le contient deja).
-- Les tableaux de tables ci-dessous doivent connatre TOUTES les tables du schéma : « npm run
-- db:sql » le verifie et echoue sinon.

CREATE OR REPLACE FUNCTION edge_schema_check() RETURNS jsonb LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  t text;
  n bigint;
  attendues text[] := array[
    'applications',
    'automod_hits',
    'automod_rules',
    'bot_events',
    'cases',
    'events_rsvp',
    'flags',
    'giveaway_entries',
    'giveaways',
    'invite_stats',
    'kv_store',
    'level_rewards',
    'members',
    'partnerships',
    'polls',
    'presentations',
    'reports',
    'scheduled_events',
    'scheduler_jobs',
    'selfroles_state',
    'suggestions',
    'ticket_messages',
    'tickets'
  ];
  manquantes text[] := '{}';
  lignes jsonb := '{}';
BEGIN
  FOREACH t IN ARRAY attendues LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace p ON p.oid = c.relnamespace
      WHERE p.nspname = 'public' AND c.relname = t AND c.relkind IN ('r', 'p')
    ) THEN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      lignes := lignes || jsonb_build_object(t, n);
    ELSE
      manquantes := array_append(manquantes, t);
    END IF;
  END LOOP;
  RETURN jsonb_build_object(
    'manquantes', coalesce(to_jsonb(manquantes), '[]'::jsonb),
    'lignes', lignes,
    'total', array_length(attendues, 1),
    'horodatage', now()
  );
END $fn$;

-- Menage les evenements techniques (audit interne d'Edge). Retourne le nombre de lignes retirees.
CREATE OR REPLACE FUNCTION edge_prune_events(p_older_than timestamptz) RETURNS bigint
LANGUAGE plpgsql AS $fn$
DECLARE n bigint;
BEGIN
  DELETE FROM bot_events WHERE created_at < p_older_than;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $fn$;

-- Compteur global pour /edge stats et la sonde : 1 appel API au lieu de 23.
CREATE OR REPLACE FUNCTION edge_counts() RETURNS jsonb LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  t text; out jsonb := '{}'; n bigint;
BEGIN
  FOREACH t IN ARRAY array[
    'applications',
    'automod_hits',
    'automod_rules',
    'bot_events',
    'cases',
    'events_rsvp',
    'flags',
    'giveaway_entries',
    'giveaways',
    'invite_stats',
    'kv_store',
    'level_rewards',
    'members',
    'partnerships',
    'polls',
    'presentations',
    'reports',
    'scheduled_events',
    'scheduler_jobs',
    'selfroles_state',
    'suggestions',
    'ticket_messages',
    'tickets'
  ] LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace p ON p.oid = c.relnamespace
      WHERE p.nspname = 'public' AND c.relname = t AND c.relkind IN ('r', 'p')
    ) THEN
      EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
      out := out || jsonb_build_object(t, n);
    END IF;
  END LOOP;
  RETURN out;
END $fn$;

-- ============================================================================
-- Empêche « npm run db:migrate » (mode connexion directe) de rejouer ce fichier :
-- les migrations sont marquées comme appliquées.
-- ============================================================================
CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
INSERT INTO schema_migrations (name) VALUES ('0001_init.sql') ON CONFLICT (name) DO NOTHING;
INSERT INTO schema_migrations (name) VALUES ('0002_edge_functions.sql') ON CONFLICT (name) DO NOTHING;

-- PostgREST doit recharger son cache de schéma pour voir les tables et fonctions neuves.
NOTIFY pgrst, 'reload schema';
