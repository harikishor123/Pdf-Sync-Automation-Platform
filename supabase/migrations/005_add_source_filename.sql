-- Store the original WhatsApp-provided filename so subsequent syncs can skip
-- downloading already-known PDFs without hashing the file content first.
alter table public.flixbus_data
  add column if not exists source_filename text;

create unique index if not exists flixbus_data_source_filename_idx
  on public.flixbus_data (source_filename)
  where source_filename is not null;
