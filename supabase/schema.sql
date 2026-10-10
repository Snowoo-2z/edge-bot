-- ============================================================================
-- EDGE · schéma complet, à coller dans Supabase :
--   Project → SQL Editor → New query → coller → Run
--
-- · Idempotent : tu peux le relancer après chaque mise à jour, il ne détruit RIEN
--   (CREATE ... IF NOT EXISTS partout, aucune DROP, aucun TRUNCATE).
-- · Il crée 24 tables, les index et 3 fonctions que Edge appelle par
--   l'API : edge_schema_check, edge_prune_events, edge_counts.
-- · Après ce fichier, Edge n'a besoin que de SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY : il
--   passe par l'API HTTP de Supabase, donc JAMAIS le mot de passe de la base ni un pooler.
-- · Généré par « npm run db:sql » à partir de migrations/*.sql — ne pas éditer à la main.
-- ============================================================================

SET search_path = public;

-- ============================================================================
-- Rattrapage : si une table existe deja (collage precedent interrompu, version precedente du
-- schema), on lui ajoute les colonnes qui lui manquent. Les colonnes presentes ne sont pas
-- modifiees, aucune donnee n'est ecrite. Les colonnes NOT NULL sont ajoutees WITHOUT contrainte
-- NOT NULL : c'est Edge qui les renseigne a chaque ecriture.
-- ============================================================================
DO $alt$ BEGIN
  IF to_regclass('public.announcements') IS NOT NULL THEN
  ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS channel_id BIGINT;
  ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS author_id BIGINT;
  ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS embed JSONB DEFAULT '{}';
  ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ;
  ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
  ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS message_id BIGINT;
  ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS error TEXT;
  ALTER TABLE public.announcements ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.applications') IS NOT NULL THEN
  ALTER TABLE public.applications ADD COLUMN IF NOT EXISTS role_requested TEXT;
  ALTER TABLE public.applications ADD COLUMN IF NOT EXISTS applicant_id BIGINT;
  ALTER TABLE public.applications ADD COLUMN IF NOT EXISTS answers JSONB DEFAULT '{}';
  ALTER TABLE public.applications ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'received';
  ALTER TABLE public.applications ADD COLUMN IF NOT EXISTS reviewed_by BIGINT;
  ALTER TABLE public.applications ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;
  ALTER TABLE public.applications ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
  ALTER TABLE public.applications ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.automod_hits') IS NOT NULL THEN
  ALTER TABLE public.automod_hits ADD COLUMN IF NOT EXISTS rule_kind TEXT;
  ALTER TABLE public.automod_hits ADD COLUMN IF NOT EXISTS user_id BIGINT;
  ALTER TABLE public.automod_hits ADD COLUMN IF NOT EXISTS message_id BIGINT;
  ALTER TABLE public.automod_hits ADD COLUMN IF NOT EXISTS channel_id BIGINT;
  ALTER TABLE public.automod_hits ADD COLUMN IF NOT EXISTS detail TEXT;
  ALTER TABLE public.automod_hits ADD COLUMN IF NOT EXISTS action_taken TEXT;
  ALTER TABLE public.automod_hits ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.automod_rules') IS NOT NULL THEN
  ALTER TABLE public.automod_rules ADD COLUMN IF NOT EXISTS kind TEXT;
  ALTER TABLE public.automod_rules ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT true;
  ALTER TABLE public.automod_rules ADD COLUMN IF NOT EXISTS params JSONB DEFAULT '{}';
  ALTER TABLE public.automod_rules ADD COLUMN IF NOT EXISTS action TEXT DEFAULT 'log';
  ALTER TABLE public.automod_rules ADD COLUMN IF NOT EXISTS strikes INT DEFAULT 1;
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.bot_events') IS NOT NULL THEN
  ALTER TABLE public.bot_events ADD COLUMN IF NOT EXISTS kind TEXT;
  ALTER TABLE public.bot_events ADD COLUMN IF NOT EXISTS payload JSONB DEFAULT '{}';
  ALTER TABLE public.bot_events ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.cases') IS NOT NULL THEN
  ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS user_id BIGINT;
  ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS moderator_id BIGINT;
  ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS type TEXT;
  ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS reason TEXT;
  ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS duration_minutes INT;
  ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS dm_sent BOOLEAN DEFAULT false;
  ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS evidence_url TEXT;
  ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS message_url TEXT;
  ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;
  ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
  ALTER TABLE public.cases ADD COLUMN IF NOT EXISTS ticket_id BIGINT;
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.events_rsvp') IS NOT NULL THEN
  ALTER TABLE public.events_rsvp ADD COLUMN IF NOT EXISTS event_row BIGINT;
  ALTER TABLE public.events_rsvp ADD COLUMN IF NOT EXISTS user_id BIGINT;
  ALTER TABLE public.events_rsvp ADD COLUMN IF NOT EXISTS state TEXT;
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.flags') IS NOT NULL THEN
  ALTER TABLE public.flags ADD COLUMN IF NOT EXISTS enabled BOOLEAN;
  ALTER TABLE public.flags ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.giveaway_entries') IS NOT NULL THEN
  ALTER TABLE public.giveaway_entries ADD COLUMN IF NOT EXISTS giveaway_id BIGINT;
  ALTER TABLE public.giveaway_entries ADD COLUMN IF NOT EXISTS user_id BIGINT;
  ALTER TABLE public.giveaway_entries ADD COLUMN IF NOT EXISTS weight NUMERIC(6,3) DEFAULT 1;
  ALTER TABLE public.giveaway_entries ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.giveaways') IS NOT NULL THEN
  ALTER TABLE public.giveaways ADD COLUMN IF NOT EXISTS message_id BIGINT;
  ALTER TABLE public.giveaways ADD COLUMN IF NOT EXISTS channel_id BIGINT;
  ALTER TABLE public.giveaways ADD COLUMN IF NOT EXISTS host_id BIGINT;
  ALTER TABLE public.giveaways ADD COLUMN IF NOT EXISTS prize TEXT;
  ALTER TABLE public.giveaways ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
  ALTER TABLE public.giveaways ADD COLUMN IF NOT EXISTS winners_count INT DEFAULT 1;
  ALTER TABLE public.giveaways ADD COLUMN IF NOT EXISTS requires_roles JSONB DEFAULT '[]';
  ALTER TABLE public.giveaways ADD COLUMN IF NOT EXISTS min_days SMALLINT DEFAULT 0;
  ALTER TABLE public.giveaways ADD COLUMN IF NOT EXISTS weights JSONB DEFAULT '{}';
  ALTER TABLE public.giveaways ADD COLUMN IF NOT EXISTS ping BOOLEAN DEFAULT true;
  ALTER TABLE public.giveaways ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'running';
  ALTER TABLE public.giveaways ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ;
  ALTER TABLE public.giveaways ADD COLUMN IF NOT EXISTS winner_ids JSONB DEFAULT '[]';
  ALTER TABLE public.giveaways ADD COLUMN IF NOT EXISTS reroll_of BIGINT;
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.invite_stats') IS NOT NULL THEN
  ALTER TABLE public.invite_stats ADD COLUMN IF NOT EXISTS user_id BIGINT;
  ALTER TABLE public.invite_stats ADD COLUMN IF NOT EXISTS code TEXT;
  ALTER TABLE public.invite_stats ADD COLUMN IF NOT EXISTS used INT DEFAULT 0;
  ALTER TABLE public.invite_stats ADD COLUMN IF NOT EXISTS month TEXT;
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.kv_store') IS NOT NULL THEN
  ALTER TABLE public.kv_store ADD COLUMN IF NOT EXISTS value JSONB;
  ALTER TABLE public.kv_store ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.level_rewards') IS NOT NULL THEN
  ALTER TABLE public.level_rewards ADD COLUMN IF NOT EXISTS level INT;
  ALTER TABLE public.level_rewards ADD COLUMN IF NOT EXISTS role_id BIGINT;
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.members') IS NOT NULL THEN
  ALTER TABLE public.members ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ DEFAULT now();
  ALTER TABLE public.members ADD COLUMN IF NOT EXISTS xp INT DEFAULT 0;
  ALTER TABLE public.members ADD COLUMN IF NOT EXISTS messages INT DEFAULT 0;
  ALTER TABLE public.members ADD COLUMN IF NOT EXISTS voice_minutes INT DEFAULT 0;
  ALTER TABLE public.members ADD COLUMN IF NOT EXISTS warn_points INT DEFAULT 0;
  ALTER TABLE public.members ADD COLUMN IF NOT EXISTS last_hash TEXT;
  ALTER TABLE public.members ADD COLUMN IF NOT EXISTS rules_accepted_at TIMESTAMPTZ;
  ALTER TABLE public.members ADD COLUMN IF NOT EXISTS presented_at TIMESTAMPTZ;
  ALTER TABLE public.members ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT false;
  ALTER TABLE public.members ADD COLUMN IF NOT EXISTS flags JSONB DEFAULT '{}';
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.partnerships') IS NOT NULL THEN
  ALTER TABLE public.partnerships ADD COLUMN IF NOT EXISTS partner_name TEXT;
  ALTER TABLE public.partnerships ADD COLUMN IF NOT EXISTS partner_guild_id BIGINT;
  ALTER TABLE public.partnerships ADD COLUMN IF NOT EXISTS contact_id BIGINT;
  ALTER TABLE public.partnerships ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
  ALTER TABLE public.partnerships ADD COLUMN IF NOT EXISTS reciprocal BOOLEAN DEFAULT false;
  ALTER TABLE public.partnerships ADD COLUMN IF NOT EXISTS member_count INT;
  ALTER TABLE public.partnerships ADD COLUMN IF NOT EXISTS invite_code TEXT;
  ALTER TABLE public.partnerships ADD COLUMN IF NOT EXISTS fails INT DEFAULT 0;
  ALTER TABLE public.partnerships ADD COLUMN IF NOT EXISTS checks INT DEFAULT 0;
  ALTER TABLE public.partnerships ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ;
  ALTER TABLE public.partnerships ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  ALTER TABLE public.partnerships ADD COLUMN IF NOT EXISTS note TEXT;
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.polls') IS NOT NULL THEN
  ALTER TABLE public.polls ADD COLUMN IF NOT EXISTS message_id BIGINT;
  ALTER TABLE public.polls ADD COLUMN IF NOT EXISTS channel_id BIGINT;
  ALTER TABLE public.polls ADD COLUMN IF NOT EXISTS author_id BIGINT;
  ALTER TABLE public.polls ADD COLUMN IF NOT EXISTS question TEXT;
  ALTER TABLE public.polls ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
  ALTER TABLE public.polls ADD COLUMN IF NOT EXISTS closed BOOLEAN DEFAULT false;
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.presentations') IS NOT NULL THEN
  ALTER TABLE public.presentations ADD COLUMN IF NOT EXISTS user_id BIGINT;
  ALTER TABLE public.presentations ADD COLUMN IF NOT EXISTS message_id BIGINT;
  ALTER TABLE public.presentations ADD COLUMN IF NOT EXISTS answers JSONB DEFAULT '{}';
  ALTER TABLE public.presentations ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT false;
  ALTER TABLE public.presentations ADD COLUMN IF NOT EXISTS verified_by BIGINT;
  ALTER TABLE public.presentations ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
  ALTER TABLE public.presentations ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.reports') IS NOT NULL THEN
  ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reporter_id BIGINT;
  ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS target_user_id BIGINT;
  ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS target_message_id BIGINT;
  ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS link TEXT;
  ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reason TEXT;
  ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'open';
  ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS ticket_id BIGINT;
  ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS founded BOOLEAN;
  ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS reviewed_by BIGINT;
  ALTER TABLE public.reports ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.scheduled_events') IS NOT NULL THEN
  ALTER TABLE public.scheduled_events ADD COLUMN IF NOT EXISTS guild_event_id BIGINT;
  ALTER TABLE public.scheduled_events ADD COLUMN IF NOT EXISTS channel_id BIGINT;
  ALTER TABLE public.scheduled_events ADD COLUMN IF NOT EXISTS creator_id BIGINT;
  ALTER TABLE public.scheduled_events ADD COLUMN IF NOT EXISTS title TEXT;
  ALTER TABLE public.scheduled_events ADD COLUMN IF NOT EXISTS starts_at TIMESTAMPTZ;
  ALTER TABLE public.scheduled_events ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'scheduled';
  ALTER TABLE public.scheduled_events ADD COLUMN IF NOT EXISTS reminded BOOLEAN DEFAULT false;
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.scheduler_jobs') IS NOT NULL THEN
  ALTER TABLE public.scheduler_jobs ADD COLUMN IF NOT EXISTS kind TEXT;
  ALTER TABLE public.scheduler_jobs ADD COLUMN IF NOT EXISTS ref_key TEXT;
  ALTER TABLE public.scheduler_jobs ADD COLUMN IF NOT EXISTS run_at TIMESTAMPTZ;
  ALTER TABLE public.scheduler_jobs ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
  ALTER TABLE public.scheduler_jobs ADD COLUMN IF NOT EXISTS locked_by TEXT;
  ALTER TABLE public.scheduler_jobs ADD COLUMN IF NOT EXISTS payload JSONB DEFAULT '{}';
  ALTER TABLE public.scheduler_jobs ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0;
  ALTER TABLE public.scheduler_jobs ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ;
  ALTER TABLE public.scheduler_jobs ADD COLUMN IF NOT EXISTS last_error TEXT;
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.selfroles_state') IS NOT NULL THEN
  ALTER TABLE public.selfroles_state ADD COLUMN IF NOT EXISTS user_id BIGINT;
  ALTER TABLE public.selfroles_state ADD COLUMN IF NOT EXISTS role_key TEXT;
  ALTER TABLE public.selfroles_state ADD COLUMN IF NOT EXISTS enabled BOOLEAN;
  ALTER TABLE public.selfroles_state ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.suggestions') IS NOT NULL THEN
  ALTER TABLE public.suggestions ADD COLUMN IF NOT EXISTS message_id BIGINT;
  ALTER TABLE public.suggestions ADD COLUMN IF NOT EXISTS thread_id BIGINT;
  ALTER TABLE public.suggestions ADD COLUMN IF NOT EXISTS author_id BIGINT;
  ALTER TABLE public.suggestions ADD COLUMN IF NOT EXISTS title TEXT;
  ALTER TABLE public.suggestions ADD COLUMN IF NOT EXISTS body TEXT;
  ALTER TABLE public.suggestions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'recu';
  ALTER TABLE public.suggestions ADD COLUMN IF NOT EXISTS staff_note TEXT;
  ALTER TABLE public.suggestions ADD COLUMN IF NOT EXISTS reviewed_by BIGINT;
  ALTER TABLE public.suggestions ADD COLUMN IF NOT EXISTS votes_up INT DEFAULT 0;
  ALTER TABLE public.suggestions ADD COLUMN IF NOT EXISTS votes_down INT DEFAULT 0;
  ALTER TABLE public.suggestions ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.ticket_messages') IS NOT NULL THEN
  ALTER TABLE public.ticket_messages ADD COLUMN IF NOT EXISTS ticket_id BIGINT;
  ALTER TABLE public.ticket_messages ADD COLUMN IF NOT EXISTS author_id BIGINT;
  ALTER TABLE public.ticket_messages ADD COLUMN IF NOT EXISTS author_name TEXT;
  ALTER TABLE public.ticket_messages ADD COLUMN IF NOT EXISTS content TEXT;
  ALTER TABLE public.ticket_messages ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT '[]';
  ALTER TABLE public.ticket_messages ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  END IF;
END $alt$;

DO $alt$ BEGIN
  IF to_regclass('public.tickets') IS NOT NULL THEN
  ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS channel_id BIGINT;
  ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS opener_id BIGINT;
  ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS type TEXT;
  ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'open';
  ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS pinged_role TEXT;
  ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS claimed_by BIGINT;
  ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS intro TEXT;
  ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();
  ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
  ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
  ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS close_reason TEXT;
  ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS closed_by TEXT;
  ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS transcript_url TEXT;
  ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS pinged_after BOOLEAN DEFAULT false;
  ALTER TABLE public.tickets ADD COLUMN IF NOT EXISTS last_message_at TIMESTAMPTZ;
  END IF;
END $alt$;

-- ============================================================================
-- Le schema lui-meme (idempotent).
-- ============================================================================
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
    'announcements',
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
    'announcements',
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
