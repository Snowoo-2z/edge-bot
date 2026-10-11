-- À exécuter une fois dans Supabase : SQL Editor > New query > Run.

-- 1) Table des réglages : une ligne par serveur Discord et par module.
create table if not exists public.edge_module_configs (
  guild_id   text        not null,
  module     text        not null,
  config     jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (guild_id, module)
);

-- RLS activée sans politique : anon / authenticated n'ont aucun accès.
-- Seule la clé service_role (utilisée par le bot) peut lire et écrire.
alter table public.edge_module_configs enable row level security;

-- 2) Bucket des images et GIF (lecture publique pour que Discord puisse afficher les URL).
insert into storage.buckets (id, name, public)
values ('edge-assets', 'edge-assets', true)
on conflict (id) do nothing;

-- 3) Niveaux vocaux : une ligne par membre et par serveur (XP et temps passé en vocal).
create table if not exists public.edge_levels (
  guild_id      text        not null,
  user_id       text        not null,
  xp            bigint      not null default 0,
  voice_seconds bigint      not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (guild_id, user_id)
);

-- Même règle que ci-dessus : seule la clé service_role (le bot) y accède.
alter table public.edge_levels enable row level security;

-- ---------------------------------------------------------------------------
-- 4. Suggestions (commande /suggestion) : une ligne par suggestion.
--    up_ids / down_ids : identifiants des membres ayant voté Pour / Contre.
--    Les votes se ferment à ends_at (3 jours après la publication).
-- ---------------------------------------------------------------------------
create table if not exists public.edge_suggestions (
  id          text primary key,
  guild_id    text not null,
  channel_id  text not null,
  message_id  text,
  author_id   text not null,
  content     text not null,
  up_ids      text[] not null default '{}',
  down_ids    text[] not null default '{}',
  created_at  timestamptz not null default now(),
  ends_at     timestamptz not null,
  closed      boolean not null default false
);

-- Même règle que ci-dessus : seule la clé service_role (le bot) y accède.
alter table public.edge_suggestions enable row level security;

-- ---------------------------------------------------------------------------
-- 5. Giveaways (commande /giveaway) : une ligne par tirage au sort.
--    participant_ids : membres inscrits ; winner_ids : gagnants tirés à la fin.
-- ---------------------------------------------------------------------------
create table if not exists public.edge_giveaways (
  id              text primary key,
  guild_id        text not null,
  channel_id      text not null,
  message_id      text,
  host_id         text not null,
  prize           text not null,
  winners_count   integer not null default 1,
  participant_ids text[] not null default '{}',
  winner_ids      text[] not null default '{}',
  created_at      timestamptz not null default now(),
  ends_at         timestamptz not null,
  ended           boolean not null default false
);

-- Même règle que ci-dessus : seule la clé service_role (le bot) y accède.
alter table public.edge_giveaways enable row level security;

-- ---------------------------------------------------------------------------
-- 6. Journal (module Logs) : une ligne par événement du serveur.
--    Purgé automatiquement après 30 jours par le bot.
-- ---------------------------------------------------------------------------
create table if not exists public.edge_logs (
  id           bigint generated always as identity primary key,
  guild_id     text        not null,
  category     text        not null,
  event        text        not null,
  title        text        not null,
  description  text        not null default '',
  actor_id     text,
  target_id    text,
  channel_id   text,
  created_at   timestamptz not null default now()
);

create index if not exists edge_logs_guild_created_idx on public.edge_logs (guild_id, created_at desc);
create index if not exists edge_logs_guild_category_idx on public.edge_logs (guild_id, category, created_at desc);

-- Même règle que ci-dessus : seule la clé service_role (le bot) y accède.
alter table public.edge_logs enable row level security;

-- ---------------------------------------------------------------------------
-- 7. Avertissements (commandes /warn, /warnings, /unwarn).
--    Le numéro affiché (#id) est l'identifiant de la ligne.
-- ---------------------------------------------------------------------------
create table if not exists public.edge_warnings (
  id            bigint generated always as identity primary key,
  guild_id      text        not null,
  user_id       text        not null,
  moderator_id  text        not null,
  reason        text        not null,
  created_at    timestamptz not null default now()
);

create index if not exists edge_warnings_guild_user_idx on public.edge_warnings (guild_id, user_id, created_at desc);

-- Même règle que ci-dessus : seule la clé service_role (le bot) y accède.
alter table public.edge_warnings enable row level security;

-- ---------------------------------------------------------------------------
-- 8. Sauvegardes du serveur (module Sauvegardes, tableau de bord uniquement).
--    « data » contient rôles, salons, configurations des modules et messages du bot.
--    Les 7 sauvegardes les plus récentes de chaque serveur sont conservées par le bot.
-- ---------------------------------------------------------------------------
create table if not exists public.edge_backups (
  id          uuid        primary key default gen_random_uuid(),
  guild_id    text        not null,
  kind        text        not null check (kind in ('manual', 'daily', 'pre_restore')),
  guild_name  text        not null,
  summary     jsonb       not null default '{}'::jsonb,
  data        jsonb       not null,
  created_at  timestamptz not null default now()
);

create index if not exists edge_backups_guild_created_idx on public.edge_backups (guild_id, created_at desc);

-- Même règle que ci-dessus : seule la clé service_role (le bot) y accède.
alter table public.edge_backups enable row level security;

-- ---------------------------------------------------------------------------
-- 9. Compression des sauvegardes (à exécuter une fois, après la section 8)
--    Les nouvelles sauvegardes sont stockées dans « data_z » (JSON compressé gzip, en base64).
--    Les anciennes lignes gardent « data » (jsonb) : le bot lit les deux formats.
-- ---------------------------------------------------------------------------
alter table public.edge_backups add column if not exists data_z text;
alter table public.edge_backups alter column data drop not null;

-- ---------------------------------------------------------------------------
-- 10. Mémoire des membres (module IA, à la demande de la personne).
--    Une ligne par membre et par serveur : « notes » est une liste de textes courts (200 caractères).
--    Lue et modifiée seulement par le bot et le tableau de bord (clé service_role).
-- ---------------------------------------------------------------------------
create table if not exists public.edge_ai_memories (
  guild_id    text        not null,
  user_id     text        not null,
  notes       jsonb       not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (guild_id, user_id)
);

-- Même règle que ci-dessus : seule la clé service_role (le bot) y accède.
alter table public.edge_ai_memories enable row level security;
