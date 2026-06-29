-- =============================================================================
-- PDF Sync – Complete Supabase Schema
-- Run once on a new project: SQL Editor → Run.
-- Safe to re-run: all statements use IF NOT EXISTS / OR REPLACE.
-- =============================================================================

create extension if not exists "pgcrypto";

-- =============================================================================
-- ENUM TYPES
-- =============================================================================

do $$ begin
  create type public.flix_driver_role as enum ('main_driver', 'host_India');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.flix_booking_source as enum ('Redbus', 'Abhibus', 'Flix');
exception when duplicate_object then null;
end $$;

-- =============================================================================
-- TABLE: flix_trips  —  one row per imported PDF
-- =============================================================================

create table if not exists public.flix_trips (
  id               uuid        primary key default gen_random_uuid(),
  bus_partner      text,
  plate            text,
  trip_date        date,
  departure_time   time,
  arrival_time     time,
  departure        text,
  arrival          text,
  pdf_hash         text        unique,      -- SHA-256; authoritative dedup
  source_filename  text,                    -- WhatsApp UUID; fast pre-download dedup
  created_at       timestamptz not null default now()
);

-- Remove columns that existed in earlier schema versions
alter table public.flix_trips drop column if exists total_passengers;
alter table public.flix_trips drop column if exists driver_count;

-- Convert existing text columns to enum types (safe if already enum)
alter table public.trip_drivers
  alter column role type public.flix_driver_role
  using role::public.flix_driver_role;

alter table public.trip_passengers
  alter column booking_source type public.flix_booking_source
  using booking_source::public.flix_booking_source;

create unique index if not exists flix_trips_source_filename_idx
  on public.flix_trips (source_filename)
  where source_filename is not null;

create index if not exists flix_trips_date_idx    on public.flix_trips (trip_date desc);
create index if not exists flix_trips_plate_idx   on public.flix_trips (plate);
create index if not exists flix_trips_route_idx   on public.flix_trips (departure, arrival);
create index if not exists flix_trips_partner_idx on public.flix_trips (bus_partner);

-- =============================================================================
-- TABLE: trip_drivers  —  one row per driver per trip
-- =============================================================================

create table if not exists public.trip_drivers (
  id          uuid        primary key default gen_random_uuid(),
  trip_id     uuid        not null references public.flix_trips(id) on delete cascade,
  driver_name text,
  role        public.flix_driver_role,
  phone       text,
  created_at  timestamptz not null default now()
);

create index if not exists trip_drivers_trip_idx on public.trip_drivers (trip_id);
create index if not exists trip_drivers_name_idx on public.trip_drivers (driver_name);

-- =============================================================================
-- TABLE: trip_passengers  —  one row per seat per trip
-- =============================================================================

create table if not exists public.trip_passengers (
  id              uuid        primary key default gen_random_uuid(),
  trip_id         uuid        not null references public.flix_trips(id) on delete cascade,
  seat_no         text,
  passenger_name  text,
  phone           text,
  booking_source  public.flix_booking_source,
  created_at      timestamptz not null default now()
);

create index if not exists trip_pax_trip_idx   on public.trip_passengers (trip_id);
create index if not exists trip_pax_phone_idx  on public.trip_passengers (phone)
  where phone is not null;
create index if not exists trip_pax_source_idx on public.trip_passengers (booking_source)
  where booking_source is not null;

-- =============================================================================
-- ROW LEVEL SECURITY
-- Service role key bypasses RLS. No policies = anon/authenticated cannot access.
-- =============================================================================

alter table public.flix_trips      enable row level security;
alter table public.trip_drivers    enable row level security;
alter table public.trip_passengers enable row level security;

-- =============================================================================
-- ANALYTICS VIEWS
-- Drop first so column changes are always applied cleanly on re-runs.
-- =============================================================================

drop view if exists public.v_repeat_passengers;
drop view if exists public.v_booking_source_stats;
drop view if exists public.v_monthly_trends;
drop view if exists public.v_partner_stats;
drop view if exists public.v_route_stats;
drop view if exists public.v_vehicle_stats;
drop view if exists public.v_driver_routes;
drop view if exists public.v_driver_stats;
drop view if exists public.v_trip_summary;

create view public.v_trip_summary as
select
  id,
  trip_date,
  departure_time,
  arrival_time,
  departure,
  arrival,
  plate,
  bus_partner,
  created_at
from public.flix_trips;

create view public.v_driver_stats as
select
  td.driver_name,
  td.phone,
  count(distinct td.trip_id)::int                       as total_trips,
  coalesce(sum(pax.cnt), 0)::int                        as total_passengers,
  round(avg(pax.cnt), 1)                                as avg_passengers_per_trip,
  min(t.trip_date)                                      as first_trip_date,
  max(t.trip_date)                                      as last_trip_date,
  count(distinct date_trunc('month', t.trip_date))::int as active_months
from public.trip_drivers td
join public.flix_trips t on t.id = td.trip_id
left join (
  select trip_id, count(*) as cnt from public.trip_passengers group by trip_id
) pax on pax.trip_id = t.id
group by td.driver_name, td.phone;

create view public.v_driver_routes as
select
  td.driver_name,
  t.departure,
  t.arrival,
  count(distinct t.id)::int as trips_on_route
from public.trip_drivers td
join public.flix_trips t on t.id = td.trip_id
group by td.driver_name, t.departure, t.arrival;

create view public.v_vehicle_stats as
select
  t.plate,
  count(distinct t.id)::int                        as total_trips,
  coalesce(sum(pax.cnt), 0)::int                   as total_passengers,
  round(avg(pax.cnt), 1)                           as avg_passengers_per_trip,
  min(t.trip_date)                                 as first_trip_date,
  max(t.trip_date)                                 as last_trip_date,
  count(distinct t.departure || t.arrival)::int    as routes_served
from public.flix_trips t
left join (
  select trip_id, count(*) as cnt from public.trip_passengers group by trip_id
) pax on pax.trip_id = t.id
group by t.plate;

create view public.v_route_stats as
select
  t.departure,
  t.arrival,
  count(distinct t.id)::int      as total_trips,
  coalesce(sum(pax.cnt), 0)::int as total_passengers,
  round(avg(pax.cnt), 1)         as avg_passengers_per_trip,
  min(t.trip_date)               as first_trip_date,
  max(t.trip_date)               as last_trip_date
from public.flix_trips t
left join (
  select trip_id, count(*) as cnt from public.trip_passengers group by trip_id
) pax on pax.trip_id = t.id
group by t.departure, t.arrival;

create view public.v_partner_stats as
select
  t.bus_partner,
  count(distinct t.id)::int      as total_trips,
  coalesce(sum(pax.cnt), 0)::int as total_passengers,
  round(avg(pax.cnt), 1)         as avg_passengers_per_trip
from public.flix_trips t
left join (
  select trip_id, count(*) as cnt from public.trip_passengers group by trip_id
) pax on pax.trip_id = t.id
group by t.bus_partner;

create view public.v_monthly_trends as
select
  date_trunc('month', t.trip_date)::date as month,
  t.departure,
  t.arrival,
  count(distinct t.id)::int              as trips,
  coalesce(sum(pax.cnt), 0)::int         as passengers,
  round(avg(pax.cnt), 1)                 as avg_passengers
from public.flix_trips t
left join (
  select trip_id, count(*) as cnt from public.trip_passengers group by trip_id
) pax on pax.trip_id = t.id
where t.trip_date is not null
group by date_trunc('month', t.trip_date), t.departure, t.arrival
order by month desc;

create view public.v_booking_source_stats as
select
  coalesce(booking_source, 'Unknown') as source,
  count(*)::int                       as total_passengers,
  count(distinct trip_id)::int        as trips_booked,
  count(distinct phone)::int          as unique_phones
from public.trip_passengers
group by booking_source;

create view public.v_repeat_passengers as
select
  tp.phone,
  count(distinct tp.trip_id)::int               as trip_count,
  min(t.trip_date)                              as first_seen,
  max(t.trip_date)                              as last_seen,
  count(distinct t.departure || t.arrival)::int as routes_taken
from public.trip_passengers tp
join public.flix_trips t on t.id = tp.trip_id
where tp.phone is not null and tp.phone <> ''
group by tp.phone
having count(distinct tp.trip_id) > 1
order by trip_count desc;
