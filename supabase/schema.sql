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

-- ---------------------------------------------------------------------------
-- 11. Journal des décisions de l'IA (module IA) : répondre ou ne pas répondre, et pourquoi.
--    Purgé automatiquement après 30 jours par le bot. Visible sur le tableau de bord.
-- ---------------------------------------------------------------------------
create table if not exists public.edge_ai_decisions (
  id          bigint      generated by default as identity primary key,
  guild_id    text        not null,
  channel_id  text,
  user_id     text,
  decision    text        not null check (decision in ('reply', 'silent')),
  reason      text        not null default '',
  excerpt     text        not null default '',
  created_at  timestamptz not null default now()
);

create index if not exists edge_ai_decisions_guild_created_idx on public.edge_ai_decisions (guild_id, created_at desc);

-- Même règle que ci-dessus : seule la clé service_role (le bot) y accède.
alter table public.edge_ai_decisions enable row level security;

-- ---------------------------------------------------------------------------
-- 12. Économie : monnaie du serveur (Edge Dollar, $). Monnaie virtuelle uniquement.
--    Chaque mouvement passe par une fonction SQL qui verrouille le compte : pas de double crédit
--    (double clic sur /daily, deux départs simultanés) et le journal est écrit dans la même transaction.
-- ---------------------------------------------------------------------------
create table if not exists public.edge_economy_accounts (
  guild_id     text        not null,
  user_id      text        not null,
  balance      bigint      not null default 0,
  started      boolean     not null default false,   -- solde de départ reçu (une seule fois)
  last_daily   timestamptz,
  daily_streak integer     not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (guild_id, user_id)
);

create table if not exists public.edge_economy_ledger (
  id            bigint      generated by default as identity primary key,
  guild_id      text        not null,
  user_id       text        not null,
  delta         bigint      not null,
  reason        text        not null,
  balance_after bigint      not null,
  created_at    timestamptz not null default now()
);

create index if not exists edge_economy_ledger_user_idx on public.edge_economy_ledger (guild_id, user_id, created_at desc);
create index if not exists edge_economy_accounts_rank_idx on public.edge_economy_accounts (guild_id, balance desc);

-- Solde de départ : une seule fois par membre.
create or replace function public.edge_economy_start(p_guild text, p_user text, p_amount bigint)
returns jsonb language plpgsql as $$
declare
  acc public.edge_economy_accounts%rowtype;
begin
  insert into public.edge_economy_accounts (guild_id, user_id) values (p_guild, p_user) on conflict do nothing;
  select * into acc from public.edge_economy_accounts where guild_id = p_guild and user_id = p_user for update;
  if acc.started then
    return jsonb_build_object('status', 'already', 'balance', acc.balance);
  end if;
  update public.edge_economy_accounts
     set balance = balance + p_amount, started = true, updated_at = now()
   where guild_id = p_guild and user_id = p_user
   returning balance into acc.balance;
  insert into public.edge_economy_ledger (guild_id, user_id, delta, reason, balance_after)
  values (p_guild, p_user, p_amount, 'start', acc.balance);
  return jsonb_build_object('status', 'ok', 'amount', p_amount, 'balance', acc.balance);
end $$;

-- Récompense quotidienne : un passage toutes les p_cooldown ; la série continue si le passage précédent
-- date de moins de p_window. Montant = base + bonus × (jours de série − 1), plafonné à p_cap.
create or replace function public.edge_economy_daily(
  p_guild text, p_user text, p_base bigint, p_bonus bigint, p_cap bigint,
  p_cooldown interval, p_window interval
) returns jsonb language plpgsql as $$
declare
  acc public.edge_economy_accounts%rowtype;
  now_ts timestamptz := now();
  streak integer;
  amount bigint;
begin
  insert into public.edge_economy_accounts (guild_id, user_id) values (p_guild, p_user) on conflict do nothing;
  select * into acc from public.edge_economy_accounts where guild_id = p_guild and user_id = p_user for update;
  if not acc.started then
    return jsonb_build_object('status', 'not_started');
  end if;
  if acc.last_daily is not null and now_ts - acc.last_daily < p_cooldown then
    return jsonb_build_object('status', 'cooldown', 'next_at', acc.last_daily + p_cooldown);
  end if;
  if acc.last_daily is not null and now_ts - acc.last_daily <= p_window then
    streak := acc.daily_streak + 1;
  else
    streak := 1;
  end if;
  amount := p_base + least(p_bonus * (streak - 1), p_cap);
  update public.edge_economy_accounts
     set balance = balance + amount, last_daily = now_ts, daily_streak = streak, updated_at = now_ts
   where guild_id = p_guild and user_id = p_user
   returning balance into acc.balance;
  insert into public.edge_economy_ledger (guild_id, user_id, delta, reason, balance_after)
  values (p_guild, p_user, amount, 'daily', acc.balance);
  return jsonb_build_object('status', 'ok', 'amount', amount, 'streak', streak, 'balance', acc.balance);
end $$;

-- Même règle que les autres tables : seule la clé service_role (le bot) y accède.
alter table public.edge_economy_accounts enable row level security;
alter table public.edge_economy_ledger enable row level security;

-- ---------------------------------------------------------------------------
-- 13. Banque du serveur et emprunts (Edge Dollar, $). Dépend de la section 12.
--    La banque commence à 300 000 $ (premier /play). Un emprunt crédite le compte et débite la banque ;
--    le remboursement fait l'inverse. Un seul emprunt ouvert par membre. Tout est verrouillé côté base.
-- ---------------------------------------------------------------------------
create table if not exists public.edge_economy_bank (
  guild_id   text        primary key,
  reserve    bigint      not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.edge_economy_loans (
  id         bigint      generated by default as identity primary key,
  guild_id   text        not null,
  user_id    text        not null,
  principal  bigint      not null,      -- montant emprunté
  total_due  bigint      not null,      -- principal + intérêts
  repaid     bigint      not null default 0,
  due_at     timestamptz not null,
  closed     boolean     not null default false,
  created_at timestamptz not null default now()
);

-- Un seul emprunt ouvert par membre.
create unique index if not exists edge_economy_loans_one_open_idx
  on public.edge_economy_loans (guild_id, user_id) where closed = false;

-- Crée la banque avec son montant initial, une seule fois.
create or replace function public.edge_economy_bank_fund(p_guild text, p_initial bigint)
returns jsonb language plpgsql as $$
declare
  current_reserve bigint;
begin
  insert into public.edge_economy_bank (guild_id, reserve) values (p_guild, p_initial) on conflict do nothing;
  select reserve into current_reserve from public.edge_economy_bank where guild_id = p_guild;
  return jsonb_build_object('reserve', current_reserve);
end $$;

-- Emprunt : p_total = montant remboursé (principal + intérêts), calculé par le bot.
create or replace function public.edge_economy_borrow(
  p_guild text, p_user text, p_amount bigint, p_total bigint, p_max bigint, p_days integer
) returns jsonb language plpgsql as $$
declare
  acc public.edge_economy_accounts%rowtype;
  reserve_now bigint;
  new_balance bigint;
  due timestamptz := now() + make_interval(days => p_days);
begin
  insert into public.edge_economy_accounts (guild_id, user_id) values (p_guild, p_user) on conflict do nothing;
  select * into acc from public.edge_economy_accounts where guild_id = p_guild and user_id = p_user for update;
  if not acc.started then
    return jsonb_build_object('status', 'not_started');
  end if;
  if exists (select 1 from public.edge_economy_loans where guild_id = p_guild and user_id = p_user and closed = false) then
    return jsonb_build_object('status', 'open_loan');
  end if;
  if p_amount <= 0 or p_amount > p_max then
    return jsonb_build_object('status', 'limit', 'max', p_max);
  end if;
  select reserve into reserve_now from public.edge_economy_bank where guild_id = p_guild for update;
  if reserve_now is null then
    return jsonb_build_object('status', 'no_bank');
  end if;
  if reserve_now < p_amount then
    return jsonb_build_object('status', 'bank_short', 'reserve', reserve_now);
  end if;
  update public.edge_economy_bank set reserve = reserve - p_amount, updated_at = now() where guild_id = p_guild;
  update public.edge_economy_accounts set balance = balance + p_amount, updated_at = now()
   where guild_id = p_guild and user_id = p_user
   returning balance into new_balance;
  insert into public.edge_economy_loans (guild_id, user_id, principal, total_due, due_at)
  values (p_guild, p_user, p_amount, p_total, due);
  insert into public.edge_economy_ledger (guild_id, user_id, delta, reason, balance_after)
  values (p_guild, p_user, p_amount, 'loan', new_balance);
  return jsonb_build_object('status', 'ok', 'balance', new_balance, 'total_due', p_total, 'due_at', due);
end $$;

-- Remboursement (partiel ou total) de l'emprunt ouvert. Les sommes reviennent à la banque.
create or replace function public.edge_economy_repay(p_guild text, p_user text, p_amount bigint)
returns jsonb language plpgsql as $$
declare
  acc public.edge_economy_accounts%rowtype;
  loan public.edge_economy_loans%rowtype;
  owed bigint;
  pay bigint;
  new_balance bigint;
begin
  select * into acc from public.edge_economy_accounts where guild_id = p_guild and user_id = p_user for update;
  if not found then
    return jsonb_build_object('status', 'no_loan');
  end if;
  select * into loan from public.edge_economy_loans
   where guild_id = p_guild and user_id = p_user and closed = false for update;
  if not found then
    return jsonb_build_object('status', 'no_loan');
  end if;
  owed := loan.total_due - loan.repaid;
  pay := least(p_amount, owed);
  if pay <= 0 then
    return jsonb_build_object('status', 'invalid');
  end if;
  if acc.balance < pay then
    return jsonb_build_object('status', 'funds', 'balance', acc.balance);
  end if;
  update public.edge_economy_accounts set balance = balance - pay, updated_at = now()
   where guild_id = p_guild and user_id = p_user
   returning balance into new_balance;
  update public.edge_economy_bank set reserve = reserve + pay, updated_at = now() where guild_id = p_guild;
  update public.edge_economy_loans
     set repaid = repaid + pay, closed = (repaid + pay >= total_due)
   where id = loan.id;
  insert into public.edge_economy_ledger (guild_id, user_id, delta, reason, balance_after)
  values (p_guild, p_user, -pay, 'repay', new_balance);
  return jsonb_build_object('status', 'ok', 'paid', pay, 'remaining', owed - pay, 'balance', new_balance);
end $$;

alter table public.edge_economy_bank enable row level security;
alter table public.edge_economy_loans enable row level security;
