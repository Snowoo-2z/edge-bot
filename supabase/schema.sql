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

-- ---------------------------------------------------------------------------
-- 14. Entreprises (Edge Dollar, $) : banques, coffres des membres et vols (/rob). Dépend des sections 12 et 13.
--    L'argent déposé en banque est protégé : seul le solde « sur soi » (edge_economy_accounts.balance) peut être volé.
--    Ordre de verrouillage fixe : entreprise, puis coffre, puis compte. Le vol verrouille deux comptes par identifiant.
-- ---------------------------------------------------------------------------
alter table public.edge_economy_accounts add column if not exists last_rob_at timestamptz;

create table if not exists public.edge_economy_companies (
  id          bigint      generated by default as identity primary key,
  guild_id    text        not null,
  owner_id    text        not null,
  kind        text        not null check (kind in ('bank')),
  name        text        not null,
  treasury    bigint      not null default 0 check (treasury >= 0),  -- revenus des abonnements, retirables par le patron
  max_storage bigint      not null check (max_storage > 0),          -- montant maximum stocké par la banque (tous abonnés)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Une entreprise par membre et par serveur, nom unique par serveur.
create unique index if not exists edge_economy_companies_owner_idx on public.edge_economy_companies (guild_id, owner_id);
create unique index if not exists edge_economy_companies_name_idx on public.edge_economy_companies (guild_id, lower(name));

create table if not exists public.edge_economy_plans (
  id          bigint      generated by default as identity primary key,
  guild_id    text        not null,
  company_id  bigint      not null references public.edge_economy_companies (id),
  name        text        not null,
  daily_price bigint      not null check (daily_price >= 0),  -- prélevé chaque jour sur le coffre
  storage     bigint      not null check (storage > 0),       -- montant maximum stocké par abonné
  active      boolean     not null default true,
  created_at  timestamptz not null default now()
);

create index if not exists edge_economy_plans_company_idx on public.edge_economy_plans (company_id) where active;

-- Coffre d'un membre sur un serveur. plan_id non nul = abonnement actif (prélèvement quotidien).
create table if not exists public.edge_economy_deposits (
  guild_id   text        not null,
  user_id    text        not null,
  company_id bigint      not null references public.edge_economy_companies (id),
  plan_id    bigint      references public.edge_economy_plans (id),
  stored     bigint      not null default 0 check (stored >= 0),
  updated_at timestamptz not null default now(),
  primary key (guild_id, user_id)
);

create index if not exists edge_economy_deposits_company_idx on public.edge_economy_deposits (company_id);

-- Traces des traitements quotidiens (un seul passage par serveur et par jour).
create table if not exists public.edge_economy_jobs (
  job_key text        primary key,
  ran_at  timestamptz not null default now()
);

-- Crée une entreprise pour le membre (une seule par membre). Le membre doit avoir reçu son solde de départ.
create or replace function public.edge_economy_company_create(
  p_guild text, p_owner text, p_kind text, p_name text, p_max bigint
) returns jsonb language plpgsql as $$
declare
  acc public.edge_economy_accounts%rowtype;
  new_id bigint;
begin
  select * into acc from public.edge_economy_accounts where guild_id = p_guild and user_id = p_owner for update;
  if acc.user_id is null or not acc.started then
    return jsonb_build_object('status', 'not_started');
  end if;
  if p_kind <> 'bank' or p_max <= 0 or length(trim(p_name)) = 0 then
    return jsonb_build_object('status', 'invalid');
  end if;
  if exists (select 1 from public.edge_economy_companies where guild_id = p_guild and owner_id = p_owner) then
    return jsonb_build_object('status', 'has_company');
  end if;
  if exists (select 1 from public.edge_economy_companies where guild_id = p_guild and lower(name) = lower(p_name)) then
    return jsonb_build_object('status', 'name_taken');
  end if;
  insert into public.edge_economy_companies (guild_id, owner_id, kind, name, max_storage)
  values (p_guild, p_owner, p_kind, p_name, p_max)
  returning id into new_id;
  return jsonb_build_object('status', 'ok', 'id', new_id);
exception when unique_violation then
  return jsonb_build_object('status', 'conflict');
end $$;

-- Ajoute un abonnement à l'entreprise du membre (5 au maximum, abonnements actifs).
create or replace function public.edge_economy_plan_add(
  p_guild text, p_owner text, p_name text, p_price bigint, p_storage bigint
) returns jsonb language plpgsql as $$
declare
  comp public.edge_economy_companies%rowtype;
  plan_count integer;
  new_id bigint;
begin
  select * into comp from public.edge_economy_companies where guild_id = p_guild and owner_id = p_owner for update;
  if comp.id is null then
    return jsonb_build_object('status', 'no_company');
  end if;
  if p_price < 0 or p_storage <= 0 or length(trim(p_name)) = 0 then
    return jsonb_build_object('status', 'invalid');
  end if;
  select count(*) into plan_count from public.edge_economy_plans where company_id = comp.id and active;
  if plan_count >= 5 then
    return jsonb_build_object('status', 'too_many', 'max', 5);
  end if;
  insert into public.edge_economy_plans (guild_id, company_id, name, daily_price, storage)
  values (p_guild, comp.id, p_name, p_price, p_storage)
  returning id into new_id;
  return jsonb_build_object('status', 'ok', 'id', new_id);
end $$;

-- Supprime un abonnement : les abonnés ne sont plus prélevés, mais leur argent reste en banque.
create or replace function public.edge_economy_plan_remove(p_guild text, p_owner text, p_plan bigint)
returns jsonb language plpgsql as $$
declare
  comp public.edge_economy_companies%rowtype;
  done bigint;
begin
  select * into comp from public.edge_economy_companies where guild_id = p_guild and owner_id = p_owner for update;
  if comp.id is null then
    return jsonb_build_object('status', 'no_company');
  end if;
  update public.edge_economy_plans set active = false
   where id = p_plan and company_id = comp.id and active;
  get diagnostics done = row_count;
  if done = 0 then
    return jsonb_build_object('status', 'not_found');
  end if;
  update public.edge_economy_deposits set plan_id = null, updated_at = now() where plan_id = p_plan;
  return jsonb_build_object('status', 'ok');
end $$;

-- Change le montant maximum que la banque peut stocker. Impossible en dessous de ce qui est déjà stocké.
create or replace function public.edge_economy_company_capacity(p_guild text, p_owner text, p_max bigint)
returns jsonb language plpgsql as $$
declare
  comp public.edge_economy_companies%rowtype;
  total_stored bigint;
begin
  select * into comp from public.edge_economy_companies where guild_id = p_guild and owner_id = p_owner for update;
  if comp.id is null then
    return jsonb_build_object('status', 'no_company');
  end if;
  if p_max <= 0 then
    return jsonb_build_object('status', 'invalid');
  end if;
  select coalesce(sum(stored), 0) into total_stored from public.edge_economy_deposits where company_id = comp.id;
  if p_max < total_stored then
    return jsonb_build_object('status', 'below_stored', 'stored', total_stored);
  end if;
  update public.edge_economy_companies set max_storage = p_max, updated_at = now() where id = comp.id;
  return jsonb_build_object('status', 'ok', 'max', p_max);
end $$;

-- Retire la trésorerie de la banque vers le compte du patron.
create or replace function public.edge_economy_treasury_withdraw(p_guild text, p_owner text, p_amount bigint)
returns jsonb language plpgsql as $$
declare
  comp public.edge_economy_companies%rowtype;
  acc public.edge_economy_accounts%rowtype;
  new_balance bigint;
begin
  select * into comp from public.edge_economy_companies where guild_id = p_guild and owner_id = p_owner for update;
  if comp.id is null then
    return jsonb_build_object('status', 'no_company');
  end if;
  if p_amount <= 0 then
    return jsonb_build_object('status', 'invalid');
  end if;
  if comp.treasury < p_amount then
    return jsonb_build_object('status', 'funds', 'treasury', comp.treasury);
  end if;
  select * into acc from public.edge_economy_accounts where guild_id = p_guild and user_id = p_owner for update;
  if acc.user_id is null or not acc.started then
    return jsonb_build_object('status', 'not_started');
  end if;
  update public.edge_economy_companies set treasury = treasury - p_amount, updated_at = now() where id = comp.id;
  update public.edge_economy_accounts set balance = balance + p_amount, updated_at = now()
   where guild_id = p_guild and user_id = p_owner
   returning balance into new_balance;
  insert into public.edge_economy_ledger (guild_id, user_id, delta, reason, balance_after)
  values (p_guild, p_owner, p_amount, 'company_withdraw', new_balance);
  return jsonb_build_object('status', 'ok', 'balance', new_balance, 'treasury', comp.treasury - p_amount);
end $$;

-- Abonnement à un plan d'une banque. Un seul abonnement par membre : pour changer de banque, il faut d'abord retirer.
create or replace function public.edge_economy_subscribe(p_guild text, p_user text, p_plan bigint)
returns jsonb language plpgsql as $$
declare
  cid bigint;
  comp public.edge_economy_companies%rowtype;
  plan public.edge_economy_plans%rowtype;
  dep public.edge_economy_deposits%rowtype;
  acc public.edge_economy_accounts%rowtype;
begin
  select company_id into cid from public.edge_economy_plans where id = p_plan and guild_id = p_guild and active;
  if cid is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  select * into comp from public.edge_economy_companies where id = cid for update;
  select * into plan from public.edge_economy_plans where id = p_plan and active;
  if plan.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  select * into dep from public.edge_economy_deposits where guild_id = p_guild and user_id = p_user for update;
  if dep.user_id is not null and dep.stored > 0 and dep.company_id <> comp.id then
    return jsonb_build_object('status', 'other_bank');
  end if;
  select * into acc from public.edge_economy_accounts where guild_id = p_guild and user_id = p_user for update;
  if acc.user_id is null or not acc.started then
    return jsonb_build_object('status', 'not_started');
  end if;
  insert into public.edge_economy_deposits (guild_id, user_id, company_id, plan_id, stored)
  values (p_guild, p_user, comp.id, plan.id, 0)
  on conflict (guild_id, user_id) do update
    set company_id = excluded.company_id, plan_id = excluded.plan_id, updated_at = now();
  return jsonb_build_object('status', 'ok', 'company_id', comp.id, 'plan_id', plan.id);
end $$;

-- Résiliation : plus de prélèvement, mais l'argent reste en banque (protégé, retirable).
create or replace function public.edge_economy_unsubscribe(p_guild text, p_user text)
returns jsonb language plpgsql as $$
declare
  dep public.edge_economy_deposits%rowtype;
begin
  select * into dep from public.edge_economy_deposits where guild_id = p_guild and user_id = p_user for update;
  if dep.user_id is null or dep.plan_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  update public.edge_economy_deposits set plan_id = null, updated_at = now()
   where guild_id = p_guild and user_id = p_user;
  return jsonb_build_object('status', 'ok', 'stored', dep.stored);
end $$;

-- Dépôt : du solde « sur soi » vers le coffre. Respecte le stockage du plan et le maximum de la banque.
create or replace function public.edge_economy_deposit(p_guild text, p_user text, p_amount bigint)
returns jsonb language plpgsql as $$
declare
  cid bigint;
  comp public.edge_economy_companies%rowtype;
  dep public.edge_economy_deposits%rowtype;
  plan public.edge_economy_plans%rowtype;
  acc public.edge_economy_accounts%rowtype;
  total_stored bigint;
  new_balance bigint;
  new_stored bigint;
begin
  select company_id into cid from public.edge_economy_deposits where guild_id = p_guild and user_id = p_user;
  if cid is null then
    return jsonb_build_object('status', 'not_subscribed');
  end if;
  select * into comp from public.edge_economy_companies where id = cid for update;
  select * into dep from public.edge_economy_deposits where guild_id = p_guild and user_id = p_user for update;
  if dep.plan_id is null then
    return jsonb_build_object('status', 'not_subscribed');
  end if;
  select * into plan from public.edge_economy_plans where id = dep.plan_id and active;
  if plan.id is null then
    return jsonb_build_object('status', 'not_subscribed');
  end if;
  if p_amount <= 0 then
    return jsonb_build_object('status', 'invalid');
  end if;
  select * into acc from public.edge_economy_accounts where guild_id = p_guild and user_id = p_user for update;
  if acc.user_id is null or not acc.started then
    return jsonb_build_object('status', 'not_started');
  end if;
  if acc.balance < p_amount then
    return jsonb_build_object('status', 'funds', 'balance', acc.balance);
  end if;
  if dep.stored + p_amount > plan.storage then
    return jsonb_build_object('status', 'over_plan', 'limit', plan.storage, 'stored', dep.stored);
  end if;
  select coalesce(sum(stored), 0) into total_stored from public.edge_economy_deposits where company_id = comp.id;
  if total_stored + p_amount > comp.max_storage then
    return jsonb_build_object('status', 'bank_full', 'free', greatest(comp.max_storage - total_stored, 0));
  end if;
  update public.edge_economy_accounts set balance = balance - p_amount, updated_at = now()
   where guild_id = p_guild and user_id = p_user
   returning balance into new_balance;
  update public.edge_economy_deposits set stored = stored + p_amount, updated_at = now()
   where guild_id = p_guild and user_id = p_user
   returning stored into new_stored;
  insert into public.edge_economy_ledger (guild_id, user_id, delta, reason, balance_after)
  values (p_guild, p_user, -p_amount, 'bank_deposit', new_balance);
  return jsonb_build_object('status', 'ok', 'stored', new_stored, 'balance', new_balance);
end $$;

-- Retrait : du coffre vers le solde « sur soi ». Possible même sans abonnement.
create or replace function public.edge_economy_withdraw(p_guild text, p_user text, p_amount bigint)
returns jsonb language plpgsql as $$
declare
  dep public.edge_economy_deposits%rowtype;
  acc public.edge_economy_accounts%rowtype;
  new_balance bigint;
  new_stored bigint;
begin
  select * into dep from public.edge_economy_deposits where guild_id = p_guild and user_id = p_user for update;
  if dep.user_id is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if p_amount <= 0 then
    return jsonb_build_object('status', 'invalid');
  end if;
  if dep.stored < p_amount then
    return jsonb_build_object('status', 'funds', 'stored', dep.stored);
  end if;
  select * into acc from public.edge_economy_accounts where guild_id = p_guild and user_id = p_user for update;
  if acc.user_id is null or not acc.started then
    return jsonb_build_object('status', 'not_started');
  end if;
  update public.edge_economy_deposits set stored = stored - p_amount, updated_at = now()
   where guild_id = p_guild and user_id = p_user
   returning stored into new_stored;
  update public.edge_economy_accounts set balance = balance + p_amount, updated_at = now()
   where guild_id = p_guild and user_id = p_user
   returning balance into new_balance;
  insert into public.edge_economy_ledger (guild_id, user_id, delta, reason, balance_after)
  values (p_guild, p_user, p_amount, 'bank_withdraw', new_balance);
  return jsonb_build_object('status', 'ok', 'stored', new_stored, 'balance', new_balance);
end $$;

-- Vol (/rob). Le voleur ne peut voler que toutes les p_cooldown_hours. Le solde volé est tiré entre 1 % et
-- p_max_percent % du solde de la victime (argent « sur soi » uniquement). La réussite est tirée selon la chance
-- calculée : base + p_slope × log10(solde / p_ref), bornée à ± p_clamp, puis entre 5 et 90 %.
-- Échec : le voleur verse une amende entre p_fine_min et p_fine_max (limitée à son solde).
create or replace function public.edge_economy_rob(
  p_guild text, p_thief text, p_victim text, p_cooldown_hours integer,
  p_base integer, p_ref bigint, p_slope numeric, p_clamp integer, p_max_percent integer,
  p_fine_min bigint, p_fine_max bigint
) returns jsonb language plpgsql as $$
declare
  thief public.edge_economy_accounts%rowtype;
  victim public.edge_economy_accounts%rowtype;
  chance integer;
  pct integer;
  amount bigint;
  fine bigint;
  paid bigint;
  success boolean;
  next_at timestamptz;
  thief_balance bigint;
  victim_balance bigint;
begin
  if p_thief = p_victim then
    return jsonb_build_object('status', 'self');
  end if;
  -- Verrouillage dans un ordre fixe (identifiant croissant) pour éviter les interblocages.
  if p_thief < p_victim then
    select * into thief from public.edge_economy_accounts where guild_id = p_guild and user_id = p_thief for update;
    select * into victim from public.edge_economy_accounts where guild_id = p_guild and user_id = p_victim for update;
  else
    select * into victim from public.edge_economy_accounts where guild_id = p_guild and user_id = p_victim for update;
    select * into thief from public.edge_economy_accounts where guild_id = p_guild and user_id = p_thief for update;
  end if;
  if thief.user_id is null or not thief.started then
    return jsonb_build_object('status', 'not_started');
  end if;
  if victim.user_id is null or not victim.started then
    return jsonb_build_object('status', 'victim_not_started');
  end if;
  if thief.last_rob_at is not null then
    next_at := thief.last_rob_at + make_interval(hours => p_cooldown_hours);
    if next_at > now() then
      return jsonb_build_object('status', 'cooldown', 'next_at', next_at);
    end if;
  end if;
  if victim.balance <= 0 then
    return jsonb_build_object('status', 'empty');
  end if;

  chance := round(p_slope * log(10, greatest(victim.balance, 1)::numeric / p_ref))::integer;
  chance := greatest(-p_clamp, least(p_clamp, chance));
  chance := greatest(5, least(90, p_base + chance));
  success := floor(random() * 100)::integer < chance;
  pct := 1 + floor(random() * p_max_percent)::integer;

  update public.edge_economy_accounts set last_rob_at = now(), updated_at = now()
   where guild_id = p_guild and user_id = p_thief;

  if success then
    amount := least(victim.balance, greatest(1, (victim.balance * pct) / 100));
    update public.edge_economy_accounts set balance = balance - amount, updated_at = now()
     where guild_id = p_guild and user_id = p_victim
     returning balance into victim_balance;
    update public.edge_economy_accounts set balance = balance + amount, updated_at = now()
     where guild_id = p_guild and user_id = p_thief
     returning balance into thief_balance;
    insert into public.edge_economy_ledger (guild_id, user_id, delta, reason, balance_after)
    values (p_guild, p_victim, -amount, 'rob_loss', victim_balance),
           (p_guild, p_thief, amount, 'rob_gain', thief_balance);
    return jsonb_build_object('status', 'ok', 'success', true, 'amount', amount, 'pct', pct, 'chance', chance,
                              'thief_balance', thief_balance, 'victim_balance', victim_balance);
  end if;

  fine := p_fine_min + floor(random() * (p_fine_max - p_fine_min + 1))::bigint;
  paid := least(fine, thief.balance);
  update public.edge_economy_accounts set balance = balance - paid, updated_at = now()
   where guild_id = p_guild and user_id = p_thief
   returning balance into thief_balance;
  update public.edge_economy_accounts set balance = balance + paid, updated_at = now()
   where guild_id = p_guild and user_id = p_victim
   returning balance into victim_balance;
  if paid > 0 then
    insert into public.edge_economy_ledger (guild_id, user_id, delta, reason, balance_after)
    values (p_guild, p_thief, -paid, 'rob_fine', thief_balance),
           (p_guild, p_victim, paid, 'rob_fine_received', victim_balance);
  end if;
  return jsonb_build_object('status', 'ok', 'success', false, 'fine', fine, 'paid', paid, 'chance', chance,
                            'thief_balance', thief_balance, 'victim_balance', victim_balance);
end $$;

-- Traitement quotidien d'une banque (appelé par le bot, une seule fois par jour et par serveur) :
--  1. chaque abonné paie le prix du jour sur son coffre, versé à la trésorerie de la banque ;
--     si le coffre ne suffit pas, l'abonnement est résilié (l'argent reste en banque) ;
--  2. le serveur prélève p_fee_bp / 10 000 du total stocké, sur la trésorerie de la banque (versé à la banque du serveur).
create or replace function public.edge_economy_bank_daily(p_guild text, p_day date, p_fee_bp integer)
returns jsonb language plpgsql as $$
declare
  comp public.edge_economy_companies%rowtype;
  dep record;
  inserted integer;
  server_bank boolean;
  total_stored bigint;
  cut bigint;
  charged integer := 0;
  cancelled integer := 0;
  cut_total bigint := 0;
begin
  insert into public.edge_economy_jobs (job_key) values ('bank:' || p_guild || ':' || p_day::text)
  on conflict do nothing;
  get diagnostics inserted = row_count;
  if inserted = 0 then
    return jsonb_build_object('status', 'already');
  end if;
  server_bank := exists (select 1 from public.edge_economy_bank where guild_id = p_guild);

  for comp in
    select * from public.edge_economy_companies where guild_id = p_guild order by id for update
  loop
    for dep in
      select d.user_id, d.stored, p.daily_price
        from public.edge_economy_deposits d
        join public.edge_economy_plans p on p.id = d.plan_id and p.active
       where d.guild_id = p_guild and d.company_id = comp.id
       order by d.user_id
         for update of d
    loop
      if dep.stored >= dep.daily_price then
        update public.edge_economy_deposits set stored = stored - dep.daily_price, updated_at = now()
         where guild_id = p_guild and user_id = dep.user_id;
        update public.edge_economy_companies set treasury = treasury + dep.daily_price, updated_at = now()
         where id = comp.id;
        charged := charged + 1;
      else
        update public.edge_economy_deposits set plan_id = null, updated_at = now()
         where guild_id = p_guild and user_id = dep.user_id;
        cancelled := cancelled + 1;
      end if;
    end loop;

    if server_bank then
      select coalesce(sum(stored), 0) into total_stored from public.edge_economy_deposits where company_id = comp.id;
      cut := least((total_stored * p_fee_bp) / 10000,
                   (select treasury from public.edge_economy_companies where id = comp.id));
      if cut > 0 then
        update public.edge_economy_companies set treasury = treasury - cut, updated_at = now() where id = comp.id;
        update public.edge_economy_bank set reserve = reserve + cut, updated_at = now() where guild_id = p_guild;
        cut_total := cut_total + cut;
      end if;
    end if;
  end loop;

  return jsonb_build_object('status', 'ok', 'charged', charged, 'cancelled', cancelled, 'server_cut', cut_total);
end $$;

-- Même règle que les autres tables : seule la clé service_role (le bot) y accède.
alter table public.edge_economy_companies enable row level security;
alter table public.edge_economy_plans enable row level security;
alter table public.edge_economy_deposits enable row level security;
alter table public.edge_economy_jobs enable row level security;
