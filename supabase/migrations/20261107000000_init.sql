-- Remote Slide Control — initial schema
--
-- Roles in a session:
--   operator  the signed-in (non-anonymous) user who owns the session
--   speaker   anonymous user who joined with an invite link (one row per device)
--   agent     anonymous user on the show laptop, paired with a 6-digit code
--
-- Run with `supabase db push`, or paste into the Supabase SQL editor.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  room text check (room is null or char_length(room) <= 120),
  talk_length_sec integer not null default 1200 check (talk_length_sec between 60 and 86400),
  created_at timestamptz not null default now()
);
create index sessions_owner_idx on public.sessions (owner);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  -- 256 bits of randomness; only ever shared as part of the speaker link.
  token text not null unique default (replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')),
  revoked boolean not null default false,
  google_slides_url text check (google_slides_url is null or char_length(google_slides_url) <= 2048),
  created_at timestamptz not null default now()
);
create index invites_session_idx on public.invites (session_id);

create table public.session_members (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('speaker', 'agent')),
  invite_id uuid references public.invites (id) on delete cascade,
  device_label text check (device_label is null or char_length(device_label) <= 60),
  created_at timestamptz not null default now(),
  constraint session_members_invite_matches_role check ((role = 'speaker') = (invite_id is not null))
);
create unique index session_members_speaker_uq on public.session_members (session_id, user_id, invite_id) where role = 'speaker';
create unique index session_members_agent_uq on public.session_members (session_id, user_id) where role = 'agent';
create index session_members_user_idx on public.session_members (user_id);
create index session_members_invite_idx on public.session_members (invite_id);

create table public.agent_pairings (
  code text primary key check (code ~ '^[0-9]{6}$'),
  session_id uuid not null references public.sessions (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.pair_attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  at timestamptz not null default now()
);
create index pair_attempts_user_idx on public.pair_attempts (user_id, at);

create table public.decks (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  invite_id uuid references public.invites (id) on delete set null,
  -- 'upload': a speaker's file, previewed on the server.
  -- 'agent':  exact slide images and notes exported by the show laptop.
  source text not null check (source in ('upload', 'agent')),
  file_name text not null check (char_length(file_name) between 1 and 255),
  storage_path text,
  status text not null default 'uploaded' check (status in ('uploaded', 'rendering', 'ready', 'failed', 'needs_agent')),
  progress integer not null default 0 check (progress between 0 and 100),
  slide_count integer check (slide_count is null or slide_count >= 0),
  aspect real check (aspect is null or aspect > 0),
  app text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index decks_agent_file_uq on public.decks (session_id, file_name) where source = 'agent';
create index decks_session_idx on public.decks (session_id);
create index decks_invite_idx on public.decks (invite_id);

create table public.slides (
  deck_id uuid not null references public.decks (id) on delete cascade,
  n integer not null check (n >= 1),
  image_path text,
  title text,
  notes text,
  builds integer check (builds is null or builds >= 0),
  hidden boolean not null default false,
  primary key (deck_id, n)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  invite_id uuid not null references public.invites (id) on delete cascade,
  text text not null check (char_length(text) between 1 and 280),
  urgent boolean not null default false,
  status text not null default 'delivered' check (status in ('delivered', 'seen', 'cleared', 'replaced')),
  created_at timestamptz not null default now(),
  seen_at timestamptz
);
create index messages_invite_idx on public.messages (invite_id, created_at desc);
create index messages_session_idx on public.messages (session_id, created_at desc);

create table public.click_log (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.sessions (id) on delete cascade,
  at timestamptz not null default now(),
  source text not null check (char_length(source) <= 80),
  command text not null check (char_length(command) <= 200),
  result text not null check (char_length(result) <= 200),
  kind text not null check (kind in ('ok', 'dup', 'blocked', 'info', 'error'))
);
create index click_log_session_idx on public.click_log (session_id, at desc);

create or replace function public.rsc_touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger decks_touch before update on public.decks
  for each row execute function public.rsc_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Helpers (security definer so policies can look across tables without
-- recursing into each other's row level security)
-- ---------------------------------------------------------------------------

create or replace function public.rsc_is_operator() returns boolean
language sql stable set search_path = '' as $$
  select auth.uid() is not null
     and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false;
$$;

create or replace function public.rsc_is_owner(p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.sessions s where s.id = p_session and s.owner = auth.uid());
$$;

create or replace function public.rsc_is_agent(p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.session_members m
    where m.session_id = p_session and m.user_id = auth.uid() and m.role = 'agent'
  );
$$;

create or replace function public.rsc_is_member(p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.session_members m where m.session_id = p_session and m.user_id = auth.uid());
$$;

create or replace function public.rsc_has_invite(p_invite uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.session_members m
    where m.invite_id = p_invite and m.user_id = auth.uid() and m.role = 'speaker'
  );
$$;

create or replace function public.rsc_invite_in_session(p_invite uuid, p_session uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.invites i where i.id = p_invite and i.session_id = p_session);
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.sessions enable row level security;
alter table public.invites enable row level security;
alter table public.session_members enable row level security;
alter table public.agent_pairings enable row level security;
alter table public.pair_attempts enable row level security;
alter table public.decks enable row level security;
alter table public.slides enable row level security;
alter table public.messages enable row level security;
alter table public.click_log enable row level security;

-- sessions
create policy sessions_select on public.sessions for select to authenticated
  using (owner = auth.uid() or public.rsc_is_member(id));
create policy sessions_insert on public.sessions for insert to authenticated
  with check (owner = auth.uid() and public.rsc_is_operator());
create policy sessions_update on public.sessions for update to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
create policy sessions_delete on public.sessions for delete to authenticated
  using (owner = auth.uid());

-- invites
create policy invites_select on public.invites for select to authenticated
  using (public.rsc_is_owner(session_id) or public.rsc_is_agent(session_id) or public.rsc_has_invite(id));
create policy invites_insert on public.invites for insert to authenticated
  with check (public.rsc_is_owner(session_id));
create policy invites_update on public.invites for update to authenticated
  using (public.rsc_is_owner(session_id)) with check (public.rsc_is_owner(session_id));
create policy invites_delete on public.invites for delete to authenticated
  using (public.rsc_is_owner(session_id));

-- session_members (rows are created only through join_with_invite / pair_agent)
create policy members_select on public.session_members for select to authenticated
  using (user_id = auth.uid() or public.rsc_is_owner(session_id));
create policy members_delete on public.session_members for delete to authenticated
  using (user_id = auth.uid() or public.rsc_is_owner(session_id));

-- agent_pairings, pair_attempts: no policies — reachable only through functions.

-- decks
create policy decks_select on public.decks for select to authenticated
  using (
    public.rsc_is_owner(session_id)
    or public.rsc_is_agent(session_id)
    or (source = 'agent' and public.rsc_is_member(session_id))
    or (invite_id is not null and public.rsc_has_invite(invite_id))
  );
create policy decks_insert on public.decks for insert to authenticated
  with check (
    public.rsc_is_owner(session_id)
    or (source = 'agent' and public.rsc_is_agent(session_id))
    or (
      source = 'upload'
      and status = 'uploaded'
      and invite_id is not null
      and public.rsc_has_invite(invite_id)
      and public.rsc_invite_in_session(invite_id, session_id)
    )
  );
create policy decks_update on public.decks for update to authenticated
  using (public.rsc_is_owner(session_id) or (source = 'agent' and public.rsc_is_agent(session_id)))
  with check (public.rsc_is_owner(session_id) or (source = 'agent' and public.rsc_is_agent(session_id)));
create policy decks_delete on public.decks for delete to authenticated
  using (
    public.rsc_is_owner(session_id)
    or (source = 'agent' and public.rsc_is_agent(session_id))
    or (source = 'upload' and invite_id is not null and public.rsc_has_invite(invite_id))
  );

-- slides: visible wherever the deck is visible; written by the agent for its own decks
create policy slides_select on public.slides for select to authenticated
  using (exists (select 1 from public.decks d where d.id = deck_id));
create policy slides_write on public.slides for all to authenticated
  using (exists (
    select 1 from public.decks d
    where d.id = deck_id and d.source = 'agent' and public.rsc_is_agent(d.session_id)
  ))
  with check (exists (
    select 1 from public.decks d
    where d.id = deck_id and d.source = 'agent' and public.rsc_is_agent(d.session_id)
  ));

-- messages
create policy messages_select on public.messages for select to authenticated
  using (public.rsc_is_owner(session_id) or public.rsc_has_invite(invite_id));
create policy messages_insert on public.messages for insert to authenticated
  with check (public.rsc_is_owner(session_id) and public.rsc_invite_in_session(invite_id, session_id));
create policy messages_update on public.messages for update to authenticated
  using (public.rsc_is_owner(session_id)) with check (public.rsc_is_owner(session_id));

-- click_log
create policy click_log_select on public.click_log for select to authenticated
  using (public.rsc_is_owner(session_id) or public.rsc_is_agent(session_id));
create policy click_log_insert on public.click_log for insert to authenticated
  with check (public.rsc_is_owner(session_id) or public.rsc_is_agent(session_id));

-- ---------------------------------------------------------------------------
-- Functions the apps call
-- ---------------------------------------------------------------------------

-- A speaker opens their invite link. Returns no row if the link is wrong or revoked.
create or replace function public.join_with_invite(p_token text, p_device text default null)
returns table (session_id uuid, invite_id uuid, display_name text, session_name text, room text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_inv public.invites%rowtype;
begin
  if v_uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  select * into v_inv from public.invites i where i.token = p_token and not i.revoked;
  if not found then
    return;
  end if;
  insert into public.session_members (session_id, user_id, role, invite_id, device_label)
  values (v_inv.session_id, v_uid, 'speaker', v_inv.id, left(p_device, 60))
  on conflict (session_id, user_id, invite_id) where role = 'speaker'
  do update set device_label = excluded.device_label;
  return query
    select v_inv.session_id, v_inv.id, v_inv.display_name, s.name, s.room
    from public.sessions s where s.id = v_inv.session_id;
end $$;

-- The operator asks for a code to type into the show laptop. Valid 10 minutes, single use.
create or replace function public.create_agent_pairing(p_session uuid)
returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_code text;
  v_try int := 0;
begin
  if not public.rsc_is_owner(p_session) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  delete from public.agent_pairings p where p.expires_at < now() - interval '1 day';
  loop
    v_code := lpad(((('x' || substr(md5(gen_random_uuid()::text), 1, 7))::bit(28)::int) % 1000000)::text, 6, '0');
    exit when not exists (
      select 1 from public.agent_pairings p where p.code = v_code and p.used_at is null and p.expires_at > now()
    );
    v_try := v_try + 1;
    if v_try > 25 then
      raise exception 'could not allocate a pairing code' using errcode = '53000';
    end if;
  end loop;
  delete from public.agent_pairings p where p.code = v_code;
  insert into public.agent_pairings (code, session_id, expires_at) values (v_code, p_session, now() + interval '10 minutes');
  return v_code;
end $$;

-- The show laptop redeems a pairing code. Ten tries per 10 minutes per device;
-- a wrong code returns no row (and the attempt is still counted).
create or replace function public.pair_agent(p_code text)
returns table (session_id uuid, session_name text, room text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_pair public.agent_pairings%rowtype;
  v_attempts int;
begin
  if v_uid is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  select count(*) into v_attempts from public.pair_attempts a
  where a.user_id = v_uid and a.at > now() - interval '10 minutes';
  if v_attempts >= 10 then
    raise exception 'too many attempts, wait a few minutes' using errcode = '54000';
  end if;
  insert into public.pair_attempts (user_id) values (v_uid);

  select * into v_pair from public.agent_pairings p
  where p.code = p_code and p.used_at is null and p.expires_at > now()
  for update;
  if not found then
    return;
  end if;
  update public.agent_pairings p set used_at = now() where p.code = v_pair.code;
  insert into public.session_members (session_id, user_id, role)
  values (v_pair.session_id, v_uid, 'agent')
  on conflict (session_id, user_id) where role = 'agent' do nothing;
  return query select s.id, s.name, s.room from public.sessions s where s.id = v_pair.session_id;
end $$;

-- The speaker taps "Got it" on a host message.
create or replace function public.ack_message(p_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.messages m set status = 'seen', seen_at = now()
  where m.id = p_id and m.status = 'delivered' and public.rsc_has_invite(m.invite_id);
end $$;

-- A speaker shares a Google Slides link instead of uploading a file.
create or replace function public.set_google_slides_url(p_invite uuid, p_url text)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_url text := nullif(btrim(coalesce(p_url, '')), '');
begin
  if not public.rsc_has_invite(p_invite) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_url is not null and v_url !~ '^https://docs\.google\.com/presentation/' then
    raise exception 'not a Google Slides link' using errcode = '22023';
  end if;
  update public.invites i set google_slides_url = v_url where i.id = p_invite;
end $$;

revoke all on function public.join_with_invite(text, text) from public, anon;
revoke all on function public.create_agent_pairing(uuid) from public, anon;
revoke all on function public.pair_agent(text) from public, anon;
revoke all on function public.ack_message(uuid) from public, anon;
revoke all on function public.set_google_slides_url(uuid, text) from public, anon;
grant execute on function public.join_with_invite(text, text) to authenticated;
grant execute on function public.create_agent_pairing(uuid) to authenticated;
grant execute on function public.pair_agent(text) to authenticated;
grant execute on function public.ack_message(uuid) to authenticated;
grant execute on function public.set_google_slides_url(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: who may join / publish on which private channel
--   rsc:<session>:state         read: any member · write: owner, agent
--   rsc:<session>:op            owner and agent only
--   rsc:<session>:spk:<invite>  owner, agent, and the speaker holding that invite
-- ---------------------------------------------------------------------------

create or replace function public.rsc_topic_allowed(p_topic text, p_write boolean)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_parts text[];
  v_session uuid;
begin
  if p_topic is null or p_topic !~ '^rsc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(state|op|spk:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$' then
    return false;
  end if;
  v_parts := string_to_array(p_topic, ':');
  v_session := v_parts[2]::uuid;
  if public.rsc_is_owner(v_session) or public.rsc_is_agent(v_session) then
    return true;
  end if;
  if v_parts[3] = 'state' then
    return not p_write and public.rsc_is_member(v_session);
  elsif v_parts[3] = 'spk' then
    return exists (
      select 1 from public.session_members m
      where m.session_id = v_session and m.user_id = auth.uid()
        and m.role = 'speaker' and m.invite_id = v_parts[4]::uuid
    );
  end if;
  return false;
end $$;

create policy rsc_realtime_receive on realtime.messages for select to authenticated
  using (public.rsc_topic_allowed((select realtime.topic()), false));
create policy rsc_realtime_send on realtime.messages for insert to authenticated
  with check (public.rsc_topic_allowed((select realtime.topic()), true));

-- Live progress for the upload page.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'decks'
     ) then
    alter publication supabase_realtime add table public.decks;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Storage: one private bucket, paths
--   <session>/uploads/<invite>/<deck>/<file>     speaker uploads
--   <session>/previews/<invite>/<deck>/<n>.png   server previews of those uploads
--   <session>/agent/<deck>/<n>.png               exact images from the show laptop
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('decks', 'decks', false)
on conflict (id) do nothing;

create or replace function public.rsc_storage_allowed(p_name text, p_write boolean)
returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_parts text[] := string_to_array(p_name, '/');
  v_session uuid;
  v_area text;
begin
  if p_name is null or v_parts[1] is null
     or v_parts[1] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  v_session := v_parts[1]::uuid;
  v_area := v_parts[2];
  if v_area not in ('uploads', 'previews', 'agent') then
    return false;
  end if;
  if public.rsc_is_owner(v_session) then
    return true;
  end if;
  if public.rsc_is_agent(v_session) then
    return (not p_write) or v_area = 'agent';
  end if;
  if v_area = 'agent' then
    return not p_write and public.rsc_is_member(v_session);
  end if;
  -- uploads/previews belong to one invite
  if v_parts[3] is null or v_parts[3] !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  if not exists (
    select 1 from public.session_members m
    where m.session_id = v_session and m.user_id = auth.uid()
      and m.role = 'speaker' and m.invite_id = v_parts[3]::uuid
  ) then
    return false;
  end if;
  return (not p_write) or v_area = 'uploads';
end $$;

create policy rsc_decks_read on storage.objects for select to authenticated
  using (bucket_id = 'decks' and public.rsc_storage_allowed(name, false));
create policy rsc_decks_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'decks' and public.rsc_storage_allowed(name, true));
create policy rsc_decks_update on storage.objects for update to authenticated
  using (bucket_id = 'decks' and public.rsc_storage_allowed(name, true))
  with check (bucket_id = 'decks' and public.rsc_storage_allowed(name, true));
create policy rsc_decks_delete on storage.objects for delete to authenticated
  using (bucket_id = 'decks' and public.rsc_storage_allowed(name, true));
