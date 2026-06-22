-- Drop old tables in reverse FK order so constraints don't block the drops.
drop table if exists public.flixbus_passengers;
drop table if exists public.flixbus_drivers;
drop table if exists public.flixbus_trips;
drop table if exists public.passenger_imports;
drop table if exists public.pdf_imports;

-- Single table for all FlixBus manifest data.
create table public.flixbus_data (
  id             uuid        primary key default gen_random_uuid(),
  bus_partner    text,
  plate          text,
  date           date,
  departure_time time,
  arrival_time   time,
  departure      text,
  arrival        text,
  driver_details jsonb,
  seat_details   jsonb,
  pdf_hash       text        unique,
  created_at     timestamptz not null default now()
);

create index if not exists flixbus_data_date_idx
  on public.flixbus_data (date desc);

create index if not exists flixbus_data_plate_date_idx
  on public.flixbus_data (plate, date);

alter table public.flixbus_data enable row level security;
