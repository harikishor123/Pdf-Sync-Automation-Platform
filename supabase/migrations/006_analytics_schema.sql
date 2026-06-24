-- =============================================================================
-- Migration 006: Production Analytics Schema
--
-- Replaces the flat flixbus_data table with a normalized star schema.
-- flixbus_data is kept intact; run 007 to migrate its rows across.
--
-- Star schema:
--   Dimensions : bus_partners, routes, vehicles, drivers, booking_sources
--   Fact       : trips  (one row per PDF)
--   Bridges    : trip_drivers, trip_passengers
-- =============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- DIMENSIONS
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.bus_partners (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.routes (
  id         uuid        primary key default gen_random_uuid(),
  departure  text        not null,
  arrival    text        not null,
  created_at timestamptz not null default now(),
  unique (departure, arrival)
);

create table if not exists public.vehicles (
  id         uuid        primary key default gen_random_uuid(),
  plate      text        not null unique,
  created_at timestamptz not null default now()
);

-- NULLS NOT DISTINCT: (name, NULL) treated as a duplicate of another (name, NULL).
-- Requires PostgreSQL 15+ (all current Supabase projects qualify).
create table if not exists public.drivers (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null,
  phone      text,
  created_at timestamptz not null default now(),
  unique nulls not distinct (name, phone)
);

create table if not exists public.booking_sources (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null unique,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- FACT TABLE
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.trips (
  id              uuid        primary key default gen_random_uuid(),
  route_id        uuid        references public.routes(id),
  vehicle_id      uuid        references public.vehicles(id),
  bus_partner_id  uuid        references public.bus_partners(id),
  trip_date       date,
  departure_time  time,
  arrival_time    time,
  pdf_hash        text        unique,
  source_filename text,
  created_at      timestamptz not null default now()
);

create unique index if not exists trips_source_filename_idx
  on public.trips (source_filename)
  where source_filename is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- BRIDGE TABLES
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.trip_drivers (
  id         uuid        primary key default gen_random_uuid(),
  trip_id    uuid        not null references public.trips(id) on delete cascade,
  driver_id  uuid        not null references public.drivers(id),
  role       text,
  created_at timestamptz not null default now(),
  unique (trip_id, driver_id)
);

create table if not exists public.trip_passengers (
  id                uuid        primary key default gen_random_uuid(),
  trip_id           uuid        not null references public.trips(id) on delete cascade,
  seat_no           text,
  passenger_name    text,
  phone             text,
  booking_source_id uuid        references public.booking_sources(id),
  created_at        timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- INDEXES
-- ─────────────────────────────────────────────────────────────────────────────

create index if not exists trips_trip_date_idx     on public.trips (trip_date desc);
create index if not exists trips_route_id_idx      on public.trips (route_id);
create index if not exists trips_vehicle_id_idx    on public.trips (vehicle_id);
create index if not exists trips_partner_id_idx    on public.trips (bus_partner_id);
create index if not exists trips_date_route_idx    on public.trips (trip_date, route_id);

create index if not exists trip_drivers_driver_idx on public.trip_drivers (driver_id);
create index if not exists trip_drivers_trip_idx   on public.trip_drivers (trip_id);

create index if not exists trip_pax_trip_idx       on public.trip_passengers (trip_id);
create index if not exists trip_pax_phone_idx      on public.trip_passengers (phone)
  where phone is not null;
create index if not exists trip_pax_source_idx     on public.trip_passengers (booking_source_id)
  where booking_source_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.bus_partners    enable row level security;
alter table public.routes          enable row level security;
alter table public.vehicles        enable row level security;
alter table public.drivers         enable row level security;
alter table public.booking_sources enable row level security;
alter table public.trips           enable row level security;
alter table public.trip_drivers    enable row level security;
alter table public.trip_passengers enable row level security;

-- ─────────────────────────────────────────────────────────────────────────────
-- ANALYTICS VIEWS
-- ─────────────────────────────────────────────────────────────────────────────

-- Full trip details — denormalized for dashboards and the getImports API.
create or replace view public.v_trip_summary as
select
  t.id,
  t.trip_date,
  t.departure_time,
  t.arrival_time,
  r.departure,
  r.arrival,
  v.plate,
  bp.name                        as bus_partner,
  count(distinct tp.id)::int     as passenger_count,
  count(distinct td.id)::int     as driver_count,
  t.created_at
from public.trips t
left join public.routes          r  on r.id  = t.route_id
left join public.vehicles        v  on v.id  = t.vehicle_id
left join public.bus_partners    bp on bp.id = t.bus_partner_id
left join public.trip_passengers tp on tp.trip_id = t.id
left join public.trip_drivers    td on td.trip_id = t.id
group by t.id, r.departure, r.arrival, v.plate, bp.name;

-- Per-driver aggregates.
create or replace view public.v_driver_stats as
select
  d.id,
  d.name,
  d.phone,
  count(distinct td.trip_id)::int                       as total_trips,
  coalesce(sum(pax.cnt), 0)::int                        as total_passengers,
  round(avg(pax.cnt), 1)                                as avg_passengers_per_trip,
  min(t.trip_date)                                      as first_trip_date,
  max(t.trip_date)                                      as last_trip_date,
  count(distinct date_trunc('month', t.trip_date))::int as active_months
from public.drivers d
join public.trip_drivers td on td.driver_id = d.id
join public.trips t         on t.id = td.trip_id
left join (
  select trip_id, count(*) as cnt from public.trip_passengers group by trip_id
) pax on pax.trip_id = t.id
group by d.id, d.name, d.phone;

-- Driver x route: how many trips each driver ran on each route.
create or replace view public.v_driver_routes as
select
  d.id                       as driver_id,
  d.name                     as driver_name,
  r.departure,
  r.arrival,
  count(distinct t.id)::int  as trips_on_route
from public.drivers d
join public.trip_drivers td on td.driver_id = d.id
join public.trips t         on t.id = td.trip_id
join public.routes r        on r.id = t.route_id
group by d.id, d.name, r.departure, r.arrival;

-- Per-vehicle aggregates.
create or replace view public.v_vehicle_stats as
select
  v.id,
  v.plate,
  count(distinct t.id)::int              as total_trips,
  coalesce(sum(pax.cnt), 0)::int         as total_passengers,
  round(avg(pax.cnt), 1)                 as avg_passengers_per_trip,
  min(t.trip_date)                       as first_trip_date,
  max(t.trip_date)                       as last_trip_date,
  count(distinct t.route_id)::int        as routes_served
from public.vehicles v
join public.trips t on t.vehicle_id = v.id
left join (
  select trip_id, count(*) as cnt from public.trip_passengers group by trip_id
) pax on pax.trip_id = t.id
group by v.id, v.plate;

-- Per-route aggregates.
create or replace view public.v_route_stats as
select
  r.id,
  r.departure,
  r.arrival,
  count(distinct t.id)::int      as total_trips,
  coalesce(sum(pax.cnt), 0)::int as total_passengers,
  round(avg(pax.cnt), 1)         as avg_passengers_per_trip,
  min(t.trip_date)               as first_trip_date,
  max(t.trip_date)               as last_trip_date
from public.routes r
join public.trips t on t.route_id = r.id
left join (
  select trip_id, count(*) as cnt from public.trip_passengers group by trip_id
) pax on pax.trip_id = t.id
group by r.id, r.departure, r.arrival;

-- Per-partner aggregates.
create or replace view public.v_partner_stats as
select
  bp.id,
  bp.name,
  count(distinct t.id)::int      as total_trips,
  coalesce(sum(pax.cnt), 0)::int as total_passengers,
  round(avg(pax.cnt), 1)         as avg_passengers_per_trip
from public.bus_partners bp
join public.trips t on t.bus_partner_id = bp.id
left join (
  select trip_id, count(*) as cnt from public.trip_passengers group by trip_id
) pax on pax.trip_id = t.id
group by bp.id, bp.name;

-- Monthly trends by route — primary feed for AI demand prediction.
create or replace view public.v_monthly_trends as
select
  date_trunc('month', t.trip_date)::date as month,
  r.departure,
  r.arrival,
  count(distinct t.id)::int              as trips,
  coalesce(sum(pax.cnt), 0)::int         as passengers,
  round(avg(pax.cnt), 1)                 as avg_passengers
from public.trips t
join public.routes r on r.id = t.route_id
left join (
  select trip_id, count(*) as cnt from public.trip_passengers group by trip_id
) pax on pax.trip_id = t.id
where t.trip_date is not null
group by date_trunc('month', t.trip_date), r.departure, r.arrival
order by month desc;

-- Booking source breakdown.
create or replace view public.v_booking_source_stats as
select
  coalesce(bs.name, 'Unknown')    as source,
  count(*)::int                   as total_passengers,
  count(distinct tp.trip_id)::int as trips_booked,
  count(distinct tp.phone)::int   as unique_phones
from public.trip_passengers tp
left join public.booking_sources bs on bs.id = tp.booking_source_id
group by bs.name;

-- Repeat passengers identified by phone number.
create or replace view public.v_repeat_passengers as
select
  tp.phone,
  count(distinct tp.trip_id)::int   as trip_count,
  min(t.trip_date)                  as first_seen,
  max(t.trip_date)                  as last_seen,
  count(distinct t.route_id)::int   as routes_taken
from public.trip_passengers tp
join public.trips t on t.id = tp.trip_id
where tp.phone is not null and tp.phone <> ''
group by tp.phone
having count(distinct tp.trip_id) > 1
order by trip_count desc;
