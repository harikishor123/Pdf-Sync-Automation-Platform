-- =============================================================================
-- PDF Sync – Complete Supabase Schema
-- Run once on a new Supabase project: SQL Editor → Run.
-- Safe to re-run: all statements use IF NOT EXISTS.
-- =============================================================================

create extension if not exists "pgcrypto";

-- =============================================================================
-- TABLE: public.flixbus_data
-- One row per imported FlixBus passenger manifest PDF.
-- =============================================================================
create table if not exists public.flixbus_data (
  id              uuid        primary key default gen_random_uuid(),
  bus_partner     text,
  plate           text,
  date            date,
  departure_time  time,
  arrival_time    time,
  departure       text,
  arrival         text,
  driver_details  jsonb,       -- [{ driver_name, role, phone }]
  seat_details    jsonb,       -- [{ seat_no, name, phone, shop }]
  pdf_hash        text        unique,
  source_filename text,        -- original WhatsApp filename; used for pre-download dedup
  created_at      timestamptz not null default now()
);

create index if not exists flixbus_data_date_idx
  on public.flixbus_data (date desc);

create index if not exists flixbus_data_plate_date_idx
  on public.flixbus_data (plate, date);

create unique index if not exists flixbus_data_source_filename_idx
  on public.flixbus_data (source_filename)
  where source_filename is not null;

-- =============================================================================
-- ROW LEVEL SECURITY
-- Service role key bypasses RLS automatically.
-- No policies = anon / authenticated roles cannot read or write this table.
-- =============================================================================
alter table public.flixbus_data enable row level security;
