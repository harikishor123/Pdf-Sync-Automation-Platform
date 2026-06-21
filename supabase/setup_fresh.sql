-- =============================================================================
-- PDF Sync – Complete Fresh Supabase Setup (FlixBus-only schema)
-- Run once on a new Supabase project: SQL Editor → Run.
-- Safe to re-run: uses IF NOT EXISTS / ON CONFLICT DO NOTHING.
-- =============================================================================

create extension if not exists "pgcrypto";

-- ===========================================================================
-- TABLE: public.flixbus_data
-- One row per imported FlixBus passenger manifest PDF.
-- ===========================================================================
create table if not exists public.flixbus_data (
  id             uuid        primary key default gen_random_uuid(),
  bus_partner    text,
  plate          text,
  date           date,
  departure_time time,
  arrival_time   time,
  departure      text,
  arrival        text,
  driver_details jsonb,       -- [{ driver_name, role, phone }]
  seat_details   jsonb,       -- [{ seat_no, name, phone, shop }]
  pdf_hash       text        unique,
  created_at     timestamptz not null default now()
);

create index if not exists flixbus_data_date_idx
  on public.flixbus_data (date desc);

create index if not exists flixbus_data_plate_date_idx
  on public.flixbus_data (plate, date);

-- ===========================================================================
-- ROW LEVEL SECURITY
-- Service role key bypasses RLS automatically.
-- No policies = anon / authenticated roles cannot read or write this table.
-- ===========================================================================
alter table public.flixbus_data enable row level security;

-- ===========================================================================
-- DONE
-- 1. Set SUPABASE_URL in .env
-- 2. Set SUPABASE_SERVICE_ROLE_KEY in .env
-- 3. npm run start:dev
-- ===========================================================================
