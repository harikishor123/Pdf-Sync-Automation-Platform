-- =============================================================================
-- PDF Sync – Complete Supabase Schema
-- Run once on a new project: SQL Editor → Run.
-- Safe to re-run: all statements use IF NOT EXISTS / OR REPLACE.
-- =============================================================================

create extension if not exists "pgcrypto";


-- =============================================================================
-- TABLE: flix_trips  —  one row per imported PDF
-- =============================================================================

create table if not exists public.flix_trips (
  id               uuid        primary key default gen_random_uuid(),
  line_number      text,
  bus_partner      text,
  vehicle_number   text,
  trip_date        date,
  departure_time   time,
  arrival_time     time,
  departure        text,
  arrival          text,
  pdf_hash              text        unique,
  whatsapp_received_at  timestamp,          -- IST local time, no timezone conversion
  created_at            timestamptz not null default now()
);

-- Remove columns that existed in earlier schema versions
alter table public.flix_trips drop column if exists total_passengers;
alter table public.flix_trips drop column if exists driver_count;

-- Add whatsapp_received_at if upgrading from an older schema version, or convert
-- from the old timestamptz type (which stored UTC) to timestamp (IST local time).
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'flix_trips'
      and column_name = 'whatsapp_received_at'
  ) then
    alter table public.flix_trips add column whatsapp_received_at timestamp;
  elsif exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'flix_trips'
      and column_name = 'whatsapp_received_at'
      and data_type = 'timestamp with time zone'
  ) then
    -- Convert existing UTC timestamptz values to IST local time
    alter table public.flix_trips
      alter column whatsapp_received_at type timestamp
      using (whatsapp_received_at at time zone 'UTC' at time zone 'Asia/Kolkata');
  end if;
end $$;


-- Remove columns that no longer exist in this schema version
drop index if exists public.flix_trips_source_filename_idx;
alter table public.flix_trips drop column if exists source_filename;

alter table public.flix_trips add column if not exists source_group text;

create index if not exists flix_trips_date_idx     on public.flix_trips (trip_date desc);
create index if not exists flix_trips_received_idx on public.flix_trips (whatsapp_received_at desc);
create index if not exists flix_trips_vehicle_number_idx   on public.flix_trips (vehicle_number);
create index if not exists flix_trips_route_idx   on public.flix_trips (departure, arrival);
create index if not exists flix_trips_partner_idx on public.flix_trips (bus_partner);
create index if not exists flix_trips_group_idx   on public.flix_trips (source_group);

-- =============================================================================
-- TABLE: flix_trip_drivers  —  one row per driver per trip
-- =============================================================================

create table if not exists public.flix_trip_drivers (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.flix_trips(id) on delete cascade,
  driver_name text,
  role        text,
  phone       text
);

alter table public.flix_trip_drivers drop column if exists created_at;

create index if not exists flix_trip_drivers_trip_idx on public.flix_trip_drivers (trip_id);
create index if not exists flix_trip_drivers_name_idx on public.flix_trip_drivers (driver_name);

-- =============================================================================
-- TABLE: flix_trip_passengers  —  one row per seat per trip
-- =============================================================================

create table if not exists public.flix_trip_passengers (
  id              uuid primary key default gen_random_uuid(),
  trip_id         uuid not null references public.flix_trips(id) on delete cascade,
  seat_no         text,
  passenger_name  text,
  phone           text,
  booking_source  text
);

alter table public.flix_trip_passengers drop column if exists created_at;

create index if not exists flix_trip_pax_trip_idx   on public.flix_trip_passengers (trip_id);
create index if not exists flix_trip_pax_phone_idx  on public.flix_trip_passengers (phone)
  where phone is not null;
create index if not exists flix_trip_pax_source_idx on public.flix_trip_passengers (booking_source)
  where booking_source is not null;

-- =============================================================================
-- ROW LEVEL SECURITY
-- Service role key bypasses RLS. No policies = anon/authenticated cannot access.
-- =============================================================================

alter table public.flix_trips      enable row level security;
alter table public.flix_trip_drivers    enable row level security;
alter table public.flix_trip_passengers enable row level security;

-- =============================================================================
-- ANALYTICS VIEWS
-- Drop first so column changes are always applied cleanly on re-runs.
-- =============================================================================

drop view if exists public.v_flix_repeat_passengers;
drop view if exists public.v_flix_booking_source_stats;
drop view if exists public.v_flix_monthly_trends;
drop view if exists public.v_flix_partner_stats;
drop view if exists public.v_flix_route_stats;
drop view if exists public.v_flix_vehicle_stats;
drop view if exists public.v_flix_driver_routes;
drop view if exists public.v_flix_driver_stats;
drop view if exists public.v_flix_trip_summary;

create view public.v_flix_trip_summary as
select
  t.id,
  t.source_group,
  t.line_number,
  t.trip_date,
  t.departure_time,
  t.arrival_time,
  t.departure,
  t.arrival,
  t.vehicle_number,
  t.bus_partner,
  t.whatsapp_received_at,
  t.created_at,
  coalesce(pax.cnt, 0)::int as passenger_count
from public.flix_trips t
left join (
  select trip_id, count(*) as cnt from public.flix_trip_passengers group by trip_id
) pax on pax.trip_id = t.id;

create view public.v_flix_driver_stats as
select
  td.driver_name,
  td.phone,
  count(distinct td.trip_id)::int                       as total_trips,
  coalesce(sum(pax.cnt), 0)::int                        as total_passengers,
  round(avg(pax.cnt), 1)                                as avg_passengers_per_trip,
  min(t.trip_date)                                      as first_trip_date,
  max(t.trip_date)                                      as last_trip_date,
  count(distinct date_trunc('month', t.trip_date))::int as active_months
from public.flix_trip_drivers td
join public.flix_trips t on t.id = td.trip_id
left join (
  select trip_id, count(*) as cnt from public.flix_trip_passengers group by trip_id
) pax on pax.trip_id = t.id
group by td.driver_name, td.phone;

create view public.v_flix_driver_routes as
select
  td.driver_name,
  t.departure,
  t.arrival,
  count(distinct t.id)::int as trips_on_route
from public.flix_trip_drivers td
join public.flix_trips t on t.id = td.trip_id
group by td.driver_name, t.departure, t.arrival;

create view public.v_flix_vehicle_stats as
select
  t.vehicle_number,
  count(distinct t.id)::int                        as total_trips,
  coalesce(sum(pax.cnt), 0)::int                   as total_passengers,
  round(avg(pax.cnt), 1)                           as avg_passengers_per_trip,
  min(t.trip_date)                                 as first_trip_date,
  max(t.trip_date)                                 as last_trip_date,
  count(distinct t.departure || t.arrival)::int    as routes_served
from public.flix_trips t
left join (
  select trip_id, count(*) as cnt from public.flix_trip_passengers group by trip_id
) pax on pax.trip_id = t.id
group by t.vehicle_number;

create view public.v_flix_route_stats as
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
  select trip_id, count(*) as cnt from public.flix_trip_passengers group by trip_id
) pax on pax.trip_id = t.id
group by t.departure, t.arrival;

create view public.v_flix_partner_stats as
select
  t.bus_partner,
  count(distinct t.id)::int      as total_trips,
  coalesce(sum(pax.cnt), 0)::int as total_passengers,
  round(avg(pax.cnt), 1)         as avg_passengers_per_trip
from public.flix_trips t
left join (
  select trip_id, count(*) as cnt from public.flix_trip_passengers group by trip_id
) pax on pax.trip_id = t.id
group by t.bus_partner;

create view public.v_flix_monthly_trends as
select
  date_trunc('month', t.trip_date)::date as month,
  t.departure,
  t.arrival,
  count(distinct t.id)::int              as trips,
  coalesce(sum(pax.cnt), 0)::int         as passengers,
  round(avg(pax.cnt), 1)                 as avg_passengers
from public.flix_trips t
left join (
  select trip_id, count(*) as cnt from public.flix_trip_passengers group by trip_id
) pax on pax.trip_id = t.id
where t.trip_date is not null
group by date_trunc('month', t.trip_date), t.departure, t.arrival
order by month desc;

create view public.v_flix_booking_source_stats as
select
  coalesce(booking_source, 'Unknown') as source,
  count(*)::int                       as total_passengers,
  count(distinct trip_id)::int        as trips_booked,
  count(distinct phone)::int          as unique_phones
from public.flix_trip_passengers
group by booking_source;

create view public.v_flix_repeat_passengers as
select
  tp.phone,
  count(distinct tp.trip_id)::int               as trip_count,
  min(t.trip_date)                              as first_seen,
  max(t.trip_date)                              as last_seen,
  count(distinct t.departure || t.arrival)::int as routes_taken
from public.flix_trip_passengers tp
join public.flix_trips t on t.id = tp.trip_id
where tp.phone is not null and tp.phone <> ''
group by tp.phone
having count(distinct tp.trip_id) > 1
order by trip_count desc;
