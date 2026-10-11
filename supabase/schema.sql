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
