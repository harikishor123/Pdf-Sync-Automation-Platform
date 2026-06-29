-- =============================================================================
-- Migration 008: Add total_passengers and driver_count to trips
--
-- Both values are known at import time (from the parsed PDF).
-- Storing them avoids COUNT subqueries in every analytics query.
-- =============================================================================

alter table public.flix_trips
  add column if not exists total_passengers int,
  add column if not exists driver_count     int;

-- Backfill existing rows from the bridge tables
update public.flix_trips t
set
  total_passengers = (select count(*) from public.trip_passengers where trip_id = t.id),
  driver_count     = (select count(*) from public.trip_drivers    where trip_id = t.id);

-- Recreate v_trip_summary to use stored values instead of COUNT subqueries
create or replace view public.v_trip_summary as
select
  id,
  trip_date,
  departure_time,
  arrival_time,
  departure,
  arrival,
  plate,
  bus_partner,
  total_passengers,
  driver_count,
  created_at
from public.flix_trips;
