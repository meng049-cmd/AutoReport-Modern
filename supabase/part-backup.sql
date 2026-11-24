-- Run in the Supabase SQL editor. This migration is independent of the legacy sync tables.
begin;

create schema if not exists autoreport_part_store;
revoke all on schema autoreport_part_store from public, anon, authenticated;

-- The creator ID bounds allocation. Backups survive anonymous authentication session changes.
create table if not exists autoreport_part_store.workspaces (
  token_digest text primary key check (token_digest ~ '^[0-9a-f]{64}$'),
  creator_id uuid not null unique,
  revision bigint not null default 0 check (revision >= 0),
  active_upload uuid,
  active_chunks integer not null default 0 check (active_chunks between 0 and 201),
  updated_at timestamptz,
  staged_upload uuid,
  staged_revision bigint,
  staged_chunks integer,
  staged_expires_at timestamptz,
  check (
    (revision = 0 and active_upload is null and active_chunks = 0 and updated_at is null)
    or (revision > 0 and active_upload is not null and active_chunks > 0 and updated_at is not null)
  ),
  check (
    (staged_upload is null and staged_revision is null and staged_chunks is null and staged_expires_at is null)
    or (staged_upload is not null and staged_revision is not null and staged_revision = revision
        and staged_chunks is not null and staged_chunks between 1 and 201 and staged_expires_at is not null)
  )
);

create table if not exists autoreport_part_store.chunks (
  token_digest text not null references autoreport_part_store.workspaces(token_digest) on delete cascade,
  upload_id uuid not null,
  chunk_index integer not null check (chunk_index between 0 and 200),
  data text not null check (pg_catalog.octet_length(data) between 4 and 350000),
  primary key (token_digest, upload_id, chunk_index)
);

alter table autoreport_part_store.workspaces enable row level security;
alter table autoreport_part_store.chunks enable row level security;
revoke all on table autoreport_part_store.workspaces, autoreport_part_store.chunks
  from public, anon, authenticated;

create or replace function autoreport_part_store.digest(p_token text)
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
revoke all on function autoreport_part_store.digest(text) from public, anon, authenticated;

-- A capability-free readiness check prevents creating sessions before installation.
create or replace function public.autoreport_part_backup_ready()
returns boolean language sql immutable set search_path = '' as $$
  select true;
$$;
revoke all on function public.autoreport_part_backup_ready() from public, anon, authenticated;
grant execute on function public.autoreport_part_backup_ready() to anon, authenticated;

create or replace function public.autoreport_part_backup_head(p_token text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_digest text := autoreport_part_store.digest(p_token);
  v_head jsonb;
begin
  select pg_catalog.jsonb_build_object('revision', revision, 'chunks', active_chunks, 'updated_at', updated_at)
    into v_head
    from autoreport_part_store.workspaces where token_digest = v_digest;
  return coalesce(v_head, '{"revision":0,"chunks":0,"updated_at":null}'::jsonb);
end;
$$;

create or replace function public.autoreport_part_backup_begin(p_token text, p_revision bigint, p_chunks integer)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_digest text := autoreport_part_store.digest(p_token);
  v_workspace autoreport_part_store.workspaces%rowtype;
  v_upload uuid := pg_catalog.gen_random_uuid();
begin
  if p_revision is null or p_revision < 0 or p_chunks is null or p_chunks not between 1 and 201 then
    raise exception 'Invalid backup revision or chunk count.' using errcode = '22023';
  end if;

  select * into v_workspace
    from autoreport_part_store.workspaces where token_digest = v_digest for update;
  if not found then
    if p_revision <> 0 then
      raise exception 'Backup revision changed.' using errcode = '40001';
    end if;
    insert into autoreport_part_store.workspaces (token_digest, creator_id)
      values (v_digest, auth.uid()) on conflict do nothing;
    select * into v_workspace
      from autoreport_part_store.workspaces where token_digest = v_digest for update;
    if not found then
      raise exception 'This session has already created a backup workspace.' using errcode = '42501';
    end if;
  end if;

  if v_workspace.revision <> p_revision then
    raise exception 'Backup revision changed.' using errcode = '40001';
  end if;
  if v_workspace.staged_expires_at > pg_catalog.clock_timestamp() then
    raise exception 'A backup upload is already in progress.' using errcode = '40001';
  end if;
  if v_workspace.staged_upload is not null then
    delete from autoreport_part_store.chunks
      where token_digest = v_digest and upload_id = v_workspace.staged_upload;
  end if;

  update autoreport_part_store.workspaces
    set staged_upload = v_upload,
        staged_revision = p_revision,
        staged_chunks = p_chunks,
        staged_expires_at = pg_catalog.clock_timestamp() + interval '30 minutes'
    where token_digest = v_digest;
  return v_upload;
end;
$$;

create or replace function public.autoreport_part_backup_put(p_token text, p_upload uuid, p_index integer, p_data text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_digest text := autoreport_part_store.digest(p_token);
  v_workspace autoreport_part_store.workspaces%rowtype;
  v_existing text;
  v_length integer := pg_catalog.octet_length(p_data);
begin
  if p_upload is null or p_index is null or p_index not between 0 and 200 or p_data is null
     or v_length not between 4 and 350000 or pg_catalog.mod(v_length, 4) <> 0
     or p_data !~ '^[A-Za-z0-9+/]+={0,2}$' then
    raise exception 'Invalid encrypted backup chunk.' using errcode = '22023';
  end if;
  select * into v_workspace
    from autoreport_part_store.workspaces where token_digest = v_digest for update;
  if not found or v_workspace.staged_upload is distinct from p_upload
     or v_workspace.staged_expires_at <= pg_catalog.clock_timestamp() then
    raise exception 'Backup upload expired or was canceled.' using errcode = 'P0002';
  end if;
  if p_index >= v_workspace.staged_chunks then
    raise exception 'Backup chunk index is out of range.' using errcode = '22023';
  end if;

  select data into v_existing from autoreport_part_store.chunks
    where token_digest = v_digest and upload_id = p_upload and chunk_index = p_index;
  if found then
    if v_existing <> p_data then
      raise exception 'Backup chunk has already been set.' using errcode = '40001';
    end if;
    return;
  end if;
  if p_index > 0 and not exists (
    select 1 from autoreport_part_store.chunks
      where token_digest = v_digest and upload_id = p_upload and chunk_index = p_index - 1
  ) then
    raise exception 'Backup chunks must be uploaded in order.' using errcode = '22023';
  end if;

  insert into autoreport_part_store.chunks (token_digest, upload_id, chunk_index, data)
    values (v_digest, p_upload, p_index, p_data);
  update autoreport_part_store.workspaces
    set staged_expires_at = pg_catalog.clock_timestamp() + interval '30 minutes'
    where token_digest = v_digest;
end;
$$;

create or replace function public.autoreport_part_backup_commit(p_token text, p_upload uuid)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_digest text := autoreport_part_store.digest(p_token);
  v_workspace autoreport_part_store.workspaces%rowtype;
  v_previous uuid;
begin
  if p_upload is null then
    raise exception 'Invalid backup upload.' using errcode = '22023';
  end if;
  select * into v_workspace
    from autoreport_part_store.workspaces where token_digest = v_digest for update;
  if not found then
    raise exception 'Backup upload expired or was canceled.' using errcode = 'P0002';
  end if;
  -- A retry can acknowledge a commit whose response the client did not receive.
  if v_workspace.active_upload = p_upload then
    return pg_catalog.jsonb_build_object('revision', v_workspace.revision, 'chunks', v_workspace.active_chunks,
                                        'updated_at', v_workspace.updated_at);
  end if;
  if v_workspace.staged_upload is distinct from p_upload or v_workspace.staged_expires_at <= pg_catalog.clock_timestamp() then
    raise exception 'Backup upload expired or was canceled.' using errcode = 'P0002';
  end if;
  if v_workspace.revision <> v_workspace.staged_revision then
    raise exception 'Backup revision changed.' using errcode = '40001';
  end if;
  if (select count(*) from autoreport_part_store.chunks where token_digest = v_digest and upload_id = p_upload)
     <> v_workspace.staged_chunks then
    raise exception 'Backup upload is incomplete.' using errcode = '22023';
  end if;

  v_previous := v_workspace.active_upload;
  update autoreport_part_store.workspaces
    set revision = revision + 1,
        active_upload = staged_upload,
        active_chunks = staged_chunks,
        updated_at = pg_catalog.clock_timestamp(),
        staged_upload = null, staged_revision = null, staged_chunks = null, staged_expires_at = null
    where token_digest = v_digest
    returning * into v_workspace;
  delete from autoreport_part_store.chunks where token_digest = v_digest and upload_id = v_previous;
  return pg_catalog.jsonb_build_object('revision', v_workspace.revision, 'chunks', v_workspace.active_chunks,
                                      'updated_at', v_workspace.updated_at);
end;
$$;

create or replace function public.autoreport_part_backup_get(p_token text, p_revision bigint, p_index integer)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_digest text := autoreport_part_store.digest(p_token);
  v_revision bigint;
  v_data text;
begin
  if p_revision is null or p_revision < 1 or p_index is null or p_index not between 0 and 200 then
    raise exception 'Invalid backup revision or chunk index.' using errcode = '22023';
  end if;
  select w.revision, c.data into v_revision, v_data
    from autoreport_part_store.workspaces w
    left join autoreport_part_store.chunks c on c.token_digest = w.token_digest
      and c.upload_id = w.active_upload and c.chunk_index = p_index
    where w.token_digest = v_digest;
  if v_revision is distinct from p_revision then
    raise exception 'Backup revision changed.' using errcode = '40001';
  end if;
  if v_data is null then
    raise exception 'Backup chunk index is out of range.' using errcode = '22023';
  end if;
  return v_data;
end;
$$;

create or replace function public.autoreport_part_backup_abort(p_token text, p_upload uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_digest text := autoreport_part_store.digest(p_token);
begin
  if p_upload is null then
    raise exception 'Invalid backup upload.' using errcode = '22023';
  end if;
  update autoreport_part_store.workspaces
    set staged_upload = null, staged_revision = null, staged_chunks = null, staged_expires_at = null
    where token_digest = v_digest and staged_upload = p_upload;
  if found then
    delete from autoreport_part_store.chunks where token_digest = v_digest and upload_id = p_upload;
  end if;
end;
$$;

revoke all on function public.autoreport_part_backup_head(text),
  public.autoreport_part_backup_begin(text, bigint, integer),
  public.autoreport_part_backup_put(text, uuid, integer, text),
  public.autoreport_part_backup_commit(text, uuid),
  public.autoreport_part_backup_get(text, bigint, integer),
  public.autoreport_part_backup_abort(text, uuid)
  from public, anon, authenticated;
grant execute on function public.autoreport_part_backup_head(text),
  public.autoreport_part_backup_begin(text, bigint, integer),
  public.autoreport_part_backup_put(text, uuid, integer, text),
  public.autoreport_part_backup_commit(text, uuid),
  public.autoreport_part_backup_get(text, bigint, integer),
  public.autoreport_part_backup_abort(text, uuid)
  to authenticated;

notify pgrst, 'reload schema';
commit;
