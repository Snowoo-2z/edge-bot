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
