-- Run in the Supabase SQL editor. This migration is independent of the workspace backup RPCs.
begin;

create schema if not exists autoreport_part_report_store;
revoke all on schema autoreport_part_report_store from public, anon, authenticated;

create table if not exists autoreport_part_report_store.report_roots (
  token_digest text primary key check (token_digest ~ '^[0-9a-f]{64}$'),
  creator_id uuid not null unique
);

create table if not exists autoreport_part_report_store.reports (
  token_digest text not null references autoreport_part_report_store.report_roots(token_digest) on delete cascade,
  report_id uuid not null,
  revision bigint not null default 0 check (revision >= 0),
  active_upload uuid,
  active_chunks integer not null default 0 check (active_chunks between 0 and 201),
  start_date date,
  end_date date,
  uploaded_at timestamptz,
  staged_upload uuid,
  staged_revision bigint,
  staged_chunks integer,
  staged_start date,
  staged_end date,
  staged_expires_at timestamptz,
  primary key (token_digest, report_id),
  check (
    (revision = 0 and active_upload is null and active_chunks = 0
      and start_date is null and end_date is null and uploaded_at is null)
    or (revision > 0 and active_upload is not null and active_chunks > 0
      and start_date is not null and end_date is not null and start_date <= end_date and uploaded_at is not null)
  ),
  check (
    (staged_upload is null and staged_revision is null and staged_chunks is null
      and staged_start is null and staged_end is null and staged_expires_at is null)
    or (staged_upload is not null and staged_revision is not null and staged_revision = revision
      and staged_chunks is not null and staged_chunks between 1 and 201 and staged_expires_at is not null
      and staged_start is not null and staged_end is not null and staged_start <= staged_end)
  )
);

create table if not exists autoreport_part_report_store.report_chunks (
  token_digest text not null,
  report_id uuid not null,
  upload_id uuid not null,
  chunk_index integer not null check (chunk_index between 0 and 200),
  data text not null check (pg_catalog.octet_length(data) between 4 and 350000),
  primary key (token_digest, report_id, upload_id, chunk_index),
  foreign key (token_digest, report_id) references autoreport_part_report_store.reports(token_digest, report_id)
    on delete cascade
);

alter table autoreport_part_report_store.report_roots enable row level security;
alter table autoreport_part_report_store.reports enable row level security;
alter table autoreport_part_report_store.report_chunks enable row level security;
revoke all on table autoreport_part_report_store.report_roots, autoreport_part_report_store.reports,
  autoreport_part_report_store.report_chunks from public, anon, authenticated;

create or replace function autoreport_part_report_store.digest(p_token text)
returns text
language plpgsql set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'An authenticated Supabase session is required.' using errcode = '42501';
  end if;
  if p_token is null or pg_catalog.octet_length(p_token) <> 64 or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid backup capability.' using errcode = '22023';
  end if;
  return pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_token, 'UTF8')), 'hex');
end;
$$;
revoke all on function autoreport_part_report_store.digest(text) from public, anon, authenticated;

create or replace function public.autoreport_part_report_ready()
returns boolean language sql immutable set search_path = '' as $$
  select true;
$$;
revoke all on function public.autoreport_part_report_ready() from public, anon, authenticated;
grant execute on function public.autoreport_part_report_ready() to anon, authenticated;

create or replace function public.autoreport_part_report_list(p_token text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_digest text := autoreport_part_report_store.digest(p_token);
  v_reports jsonb;
begin
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id', report_id, 'start', pg_catalog.to_char(start_date, 'YYYY-MM-DD'),
    'end', pg_catalog.to_char(end_date, 'YYYY-MM-DD'), 'uploaded_at', uploaded_at,
    'revision', revision, 'chunks', active_chunks
  ) order by uploaded_at desc, report_id) into v_reports
    from autoreport_part_report_store.reports where token_digest = v_digest and revision > 0;
  return coalesce(v_reports, '[]'::jsonb);
end;
$$;

create or replace function public.autoreport_part_report_head(p_token text, p_report uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_digest text := autoreport_part_report_store.digest(p_token);
  v_head jsonb;
begin
  if p_report is null then
    raise exception 'Invalid report ID.' using errcode = '22023';
  end if;
  select pg_catalog.jsonb_build_object('revision', revision, 'chunks', active_chunks, 'updated_at', uploaded_at)
    into v_head
    from autoreport_part_report_store.reports where token_digest = v_digest and report_id = p_report;
  return coalesce(v_head, '{"revision":0,"chunks":0,"updated_at":null}'::jsonb);
end;
$$;

create or replace function public.autoreport_part_report_begin(
  p_token text, p_report uuid, p_revision bigint, p_chunks integer, p_start date, p_end date)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_digest text := autoreport_part_report_store.digest(p_token);
  v_report autoreport_part_report_store.reports%rowtype;
  v_upload uuid := pg_catalog.gen_random_uuid();
begin
  if p_report is null or p_revision is null or p_revision < 0 or p_chunks is null or p_chunks not between 1 and 201
     or p_start is null or p_end is null or p_start < date '0001-01-01' or p_end > date '9999-12-31'
     or p_start > p_end then
    raise exception 'Invalid backup revision, chunk count, report ID or dates.' using errcode = '22023';
  end if;

  -- Serialize allocation within a root so concurrent uploads cannot exceed the report cap.
  perform 1 from autoreport_part_report_store.report_roots where token_digest = v_digest for update;
  if not found then
    if p_revision <> 0 then
      raise exception 'Backup revision changed.' using errcode = '40001';
    end if;
    insert into autoreport_part_report_store.report_roots (token_digest, creator_id)
      values (v_digest, auth.uid()) on conflict do nothing;
    perform 1 from autoreport_part_report_store.report_roots where token_digest = v_digest for update;
    if not found then
      raise exception 'This session has already created a report workspace.' using errcode = '42501';
    end if;
  end if;

  select * into v_report from autoreport_part_report_store.reports
    where token_digest = v_digest and report_id = p_report for update;
  if not found then
    if p_revision <> 0 then
      raise exception 'Backup revision changed.' using errcode = '40001';
    end if;
    delete from autoreport_part_report_store.reports
      where token_digest = v_digest and revision = 0 and staged_expires_at <= pg_catalog.clock_timestamp();
    if (select count(*) from autoreport_part_report_store.reports where token_digest = v_digest) >= 30 then
      raise exception 'The report workspace is full (30 reports).' using errcode = '22023';
    end if;
    insert into autoreport_part_report_store.reports (token_digest, report_id)
      values (v_digest, p_report) returning * into v_report;
  end if;

  if v_report.revision <> p_revision then
    raise exception 'Backup revision changed.' using errcode = '40001';
  end if;
  if v_report.staged_expires_at > pg_catalog.clock_timestamp() then
    raise exception 'A backup upload is already in progress.' using errcode = '40001';
  end if;
  if v_report.staged_upload is not null then
    delete from autoreport_part_report_store.report_chunks
      where token_digest = v_digest and report_id = p_report and upload_id = v_report.staged_upload;
  end if;

  update autoreport_part_report_store.reports
    set staged_upload = v_upload, staged_revision = p_revision, staged_chunks = p_chunks,
        staged_start = p_start, staged_end = p_end, staged_expires_at = pg_catalog.clock_timestamp() + interval '30 minutes'
    where token_digest = v_digest and report_id = p_report;
  return v_upload;
end;
$$;

create or replace function public.autoreport_part_report_put(
  p_token text, p_report uuid, p_upload uuid, p_index integer, p_data text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_digest text := autoreport_part_report_store.digest(p_token);
  v_report autoreport_part_report_store.reports%rowtype;
  v_existing text;
  v_length integer := pg_catalog.octet_length(p_data);
begin
  if p_report is null or p_upload is null or p_index is null or p_index not between 0 and 200 or p_data is null
     or v_length not between 4 and 350000 or pg_catalog.mod(v_length, 4) <> 0
     or p_data !~ '^[A-Za-z0-9+/]+={0,2}$' then
    raise exception 'Invalid encrypted report chunk.' using errcode = '22023';
  end if;
  select * into v_report from autoreport_part_report_store.reports
    where token_digest = v_digest and report_id = p_report for update;
  if not found or v_report.staged_upload is distinct from p_upload
     or v_report.staged_expires_at <= pg_catalog.clock_timestamp() then
    raise exception 'Backup upload expired or was canceled.' using errcode = 'P0002';
  end if;
  if p_index >= v_report.staged_chunks then
    raise exception 'Backup chunk index is out of range.' using errcode = '22023';
  end if;

  select data into v_existing from autoreport_part_report_store.report_chunks
    where token_digest = v_digest and report_id = p_report and upload_id = p_upload and chunk_index = p_index;
  if found then
    if v_existing <> p_data then
      raise exception 'Backup chunk has already been set.' using errcode = '40001';
    end if;
    return;
  end if;
  if p_index > 0 and not exists (
    select 1 from autoreport_part_report_store.report_chunks
      where token_digest = v_digest and report_id = p_report and upload_id = p_upload and chunk_index = p_index - 1
  ) then
    raise exception 'Backup chunks must be uploaded in order.' using errcode = '22023';
  end if;

  insert into autoreport_part_report_store.report_chunks (token_digest, report_id, upload_id, chunk_index, data)
    values (v_digest, p_report, p_upload, p_index, p_data);
  update autoreport_part_report_store.reports
    set staged_expires_at = pg_catalog.clock_timestamp() + interval '30 minutes'
    where token_digest = v_digest and report_id = p_report;
end;
$$;

create or replace function public.autoreport_part_report_commit(p_token text, p_report uuid, p_upload uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_digest text := autoreport_part_report_store.digest(p_token);
  v_report autoreport_part_report_store.reports%rowtype;
  v_previous uuid;
begin
  if p_report is null or p_upload is null then
    raise exception 'Invalid backup upload.' using errcode = '22023';
  end if;
  select * into v_report from autoreport_part_report_store.reports
    where token_digest = v_digest and report_id = p_report for update;
  if not found then
    raise exception 'Backup upload expired or was canceled.' using errcode = 'P0002';
  end if;
  if v_report.active_upload = p_upload then
    return pg_catalog.jsonb_build_object('revision', v_report.revision, 'chunks', v_report.active_chunks,
                                        'updated_at', v_report.uploaded_at);
  end if;
  if v_report.staged_upload is distinct from p_upload or v_report.staged_expires_at <= pg_catalog.clock_timestamp() then
    raise exception 'Backup upload expired or was canceled.' using errcode = 'P0002';
  end if;
  if v_report.revision <> v_report.staged_revision then
    raise exception 'Backup revision changed.' using errcode = '40001';
  end if;
  if (select count(*) from autoreport_part_report_store.report_chunks
      where token_digest = v_digest and report_id = p_report and upload_id = p_upload) <> v_report.staged_chunks then
    raise exception 'Backup upload is incomplete.' using errcode = '22023';
  end if;

  v_previous := v_report.active_upload;
  update autoreport_part_report_store.reports
    set revision = revision + 1, active_upload = staged_upload, active_chunks = staged_chunks,
        start_date = staged_start, end_date = staged_end, uploaded_at = pg_catalog.clock_timestamp(),
        staged_upload = null, staged_revision = null, staged_chunks = null,
        staged_start = null, staged_end = null, staged_expires_at = null
    where token_digest = v_digest and report_id = p_report returning * into v_report;
  delete from autoreport_part_report_store.report_chunks
    where token_digest = v_digest and report_id = p_report and upload_id = v_previous;
  return pg_catalog.jsonb_build_object('revision', v_report.revision, 'chunks', v_report.active_chunks,
                                      'updated_at', v_report.uploaded_at);
end;
$$;

create or replace function public.autoreport_part_report_get(
  p_token text, p_report uuid, p_revision bigint, p_index integer)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_digest text := autoreport_part_report_store.digest(p_token);
  v_revision bigint;
  v_data text;
begin
  if p_report is null or p_revision is null or p_revision < 1 or p_index is null or p_index not between 0 and 200 then
    raise exception 'Invalid report ID, revision or chunk index.' using errcode = '22023';
  end if;
  select r.revision, c.data into v_revision, v_data
    from autoreport_part_report_store.reports r
    left join autoreport_part_report_store.report_chunks c on c.token_digest = r.token_digest
      and c.report_id = r.report_id and c.upload_id = r.active_upload and c.chunk_index = p_index
    where r.token_digest = v_digest and r.report_id = p_report;
  if v_revision is distinct from p_revision then
    raise exception 'Backup revision changed.' using errcode = '40001';
  end if;
  if v_data is null then
    raise exception 'Backup chunk index is out of range.' using errcode = '22023';
  end if;
  return v_data;
end;
$$;

create or replace function public.autoreport_part_report_abort(p_token text, p_report uuid, p_upload uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_digest text := autoreport_part_report_store.digest(p_token);
  v_revision bigint;
begin
  if p_report is null or p_upload is null then
    raise exception 'Invalid backup upload.' using errcode = '22023';
  end if;
  select revision into v_revision from autoreport_part_report_store.reports
    where token_digest = v_digest and report_id = p_report and staged_upload = p_upload for update;
  if not found then
    return;
  end if;
  if v_revision = 0 then
    delete from autoreport_part_report_store.reports where token_digest = v_digest and report_id = p_report;
    return;
  end if;
  update autoreport_part_report_store.reports
    set staged_upload = null, staged_revision = null, staged_chunks = null,
        staged_start = null, staged_end = null, staged_expires_at = null
    where token_digest = v_digest and report_id = p_report;
  delete from autoreport_part_report_store.report_chunks
    where token_digest = v_digest and report_id = p_report and upload_id = p_upload;
end;
$$;

revoke all on function public.autoreport_part_report_list(text),
  public.autoreport_part_report_head(text, uuid),
  public.autoreport_part_report_begin(text, uuid, bigint, integer, date, date),
  public.autoreport_part_report_put(text, uuid, uuid, integer, text),
  public.autoreport_part_report_commit(text, uuid, uuid),
  public.autoreport_part_report_get(text, uuid, bigint, integer),
  public.autoreport_part_report_abort(text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.autoreport_part_report_list(text),
  public.autoreport_part_report_head(text, uuid),
  public.autoreport_part_report_begin(text, uuid, bigint, integer, date, date),
  public.autoreport_part_report_put(text, uuid, uuid, integer, text),
  public.autoreport_part_report_commit(text, uuid, uuid),
  public.autoreport_part_report_get(text, uuid, bigint, integer),
  public.autoreport_part_report_abort(text, uuid, uuid)
  to authenticated;

notify pgrst, 'reload schema';
commit;
