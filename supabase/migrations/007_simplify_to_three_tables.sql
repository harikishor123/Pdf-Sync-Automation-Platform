-- =============================================================================
-- Migration 007: Simplify from star schema to 3 tables
--
-- The 5 dimension tables (bus_partners, routes, vehicles, drivers,
-- booking_sources) add upsert round trips per import with no real benefit
-- at this scale. Plain text columns on the fact/bridge tables give identical
-- analytics capability with far less complexity.
--
-- Final schema:
--   trips           — one row per PDF
--   trip_drivers    — one row per driver per trip
--   trip_passengers — one row per seat per trip
-- =============================================================================

-- Drop views that reference the old tables
drop view if exists public.v_trip_summary;
drop view if exists public.v_driver_stats;
drop view if exists public.v_driver_routes;
drop view if exists public.v_vehicle_stats;
drop view if exists public.v_route_stats;
drop view if exists public.v_partner_stats;
drop view if exists public.v_monthly_trends;
drop view if exists public.v_booking_source_stats;
drop view if exists public.v_repeat_passengers;

-- ─────────────────────────────────────────────────────────────────────────────
-- Create simplified tables (suffix _v2 to avoid name collision during migration)
-- ─────────────────────────────────────────────────────────────────────────────

create table public.trips_v2 (
  id              uuid        primary key default gen_random_uuid(),
  bus_partner     text,
  plate           text,
  trip_date       date,
  departure_time  time,
  arrival_time    time,
  departure       text,
  arrival         text,
  pdf_hash        text        unique,
  source_filename text,
  created_at      timestamptz not null default now()
);

create table public.trip_drivers_v2 (
  id          uuid        primary key default gen_random_uuid(),
  trip_id     uuid        not null references public.trips_v2(id) on delete cascade,
  driver_name text,
  role        text,
  phone       text,
  created_at  timestamptz not null default now()
);

create table public.trip_passengers_v2 (
  id              uuid        primary key default gen_random_uuid(),
  trip_id         uuid        not null references public.trips_v2(id) on delete cascade,
  seat_no         text,
  passenger_name  text,
  phone           text,
  booking_source  text,
  created_at      timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Migrate data from the star schema into the simplified tables
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.trips_v2 (id, bus_partner, plate, trip_date, departure_time, arrival_time, departure, arrival, pdf_hash, source_filename, created_at)
select
  t.id,
  bp.name     as bus_partner,
  v.plate,
  t.trip_date,
  t.departure_time,
  t.arrival_time,
  r.departure,
  r.arrival,
  t.pdf_hash,
  t.source_filename,
  t.created_at
from public.trips t
left join public.bus_partners bp on bp.id = t.bus_partner_id
left join public.vehicles     v  on v.id  = t.vehicle_id
left join public.routes       r  on r.id  = t.route_id;

insert into public.trip_drivers_v2 (trip_id, driver_name, role, phone, created_at)
select td.trip_id, d.name, td.role, d.phone, td.created_at
from public.trip_drivers td
join public.drivers d on d.id = td.driver_id;

insert into public.trip_passengers_v2 (trip_id, seat_no, passenger_name, phone, booking_source, created_at)
select tp.trip_id, tp.seat_no, tp.passenger_name, tp.phone, bs.name, tp.created_at
from public.trip_passengers tp
left join public.booking_sources bs on bs.id = tp.booking_source_id;

-- ─────────────────────────────────────────────────────────────────────────────
-- Drop old tables (order matters — children before parents, bridge before dims)
-- ─────────────────────────────────────────────────────────────────────────────

drop table public.trip_passengers;
drop table public.trip_drivers;
drop table public.trips;
drop table public.booking_sources;
drop table public.drivers;
drop table public.vehicles;
drop table public.routes;
drop table public.bus_partners;

-- ─────────────────────────────────────────────────────────────────────────────
-- Rename simplified tables to final names
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.trips_v2          rename to trips;
alter table public.trip_drivers_v2   rename to trip_drivers;
alter table public.trip_passengers_v2 rename to trip_passengers;

-- ─────────────────────────────────────────────────────────────────────────────
-- Indexes
-- ─────────────────────────────────────────────────────────────────────────────

create unique index trips_source_filename_idx
  on public.trips (source_filename) where source_filename is not null;

create index trips_date_idx          on public.trips (trip_date desc);
create index trips_plate_idx         on public.trips (plate);
create index trips_route_idx         on public.trips (departure, arrival);
create index trips_partner_idx       on public.trips (bus_partner);

create index trip_drivers_trip_idx   on public.trip_drivers (trip_id);
create index trip_drivers_name_idx   on public.trip_drivers (driver_name);

create index trip_pax_trip_idx       on public.trip_passengers (trip_id);
create index trip_pax_phone_idx      on public.trip_passengers (phone) where phone is not null;
create index trip_pax_source_idx     on public.trip_passengers (booking_source) where booking_source is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.trips           enable row level security;
alter table public.trip_drivers    enable row level security;
alter table public.trip_passengers enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- Analytics Views
-- ─────────────────────────────────────────────────────────────────────────────

create view public.v_trip_summary as
select
  t.id,
  t.trip_date,
  t.departure_time,
  t.arrival_time,
  t.departure,
  t.arrival,
  t.plate,
  t.bus_partner,
  count(distinct tp.id)::int  as passenger_count,
  count(distinct td.id)::int  as driver_count,
  t.created_at
from public.trips t
left join public.trip_passengers tp on tp.trip_id = t.id
left join public.trip_drivers    td on td.trip_id = t.id
group by t.id;

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
join public.trips t on t.id = td.trip_id
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
join public.trips t on t.id = td.trip_id
group by td.driver_name, t.departure, t.arrival;

create view public.v_vehicle_stats as
select
  t.plate,
  count(distinct t.id)::int              as total_trips,
  coalesce(sum(pax.cnt), 0)::int         as total_passengers,
  round(avg(pax.cnt), 1)                 as avg_passengers_per_trip,
  min(t.trip_date)                       as first_trip_date,
  max(t.trip_date)                       as last_trip_date,
  count(distinct t.departure || t.arrival)::int as routes_served
from public.trips t
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
from public.trips t
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
from public.trips t
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
from public.trips t
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
  count(distinct tp.trip_id)::int  as trip_count,
  min(t.trip_date)                 as first_seen,
  max(t.trip_date)                 as last_seen,
  count(distinct t.departure || t.arrival)::int as routes_taken
from public.trip_passengers tp
join public.trips t on t.id = tp.trip_id
where tp.phone is not null and tp.phone <> ''
group by tp.phone
having count(distinct tp.trip_id) > 1
order by trip_count desc;
