-- Access-rule tests. Run with supabase/tests/run-local.sh (plain Postgres + stubs).
\set ON_ERROR_STOP on
\set QUIET on

-- Users: an operator, a second operator, two speakers (anonymous) and an agent (anonymous).
insert into auth.users (id) values
  ('00000000-0000-4000-8000-00000000000a'),
  ('00000000-0000-4000-8000-00000000000b'),
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002'),
  ('00000000-0000-4000-8000-0000000000ae');

create or replace function pg_temp.act_as(p_uid text, p_anon boolean) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'is_anonymous', p_anon, 'role', 'authenticated')::text, false),
         set_config('request.jwt.claim.sub', p_uid, false);
$$;
grant execute on function pg_temp.act_as(text, boolean) to authenticated;

set role authenticated;

-- 1. Anonymous users cannot create sessions; operators can.
select pg_temp.act_as('00000000-0000-4000-8000-000000000001', true);
do $$ begin
  begin
    insert into public.sessions (name) values ('nope');
    raise exception 'anonymous user created a session';
  exception when insufficient_privilege then null;
  end;
end $$;

select pg_temp.act_as('00000000-0000-4000-8000-00000000000a', false);
insert into public.sessions (id, name, room) values ('aaaaaaaa-0000-4000-8000-000000000001', 'Opening keynote', 'Hall A');
insert into public.invites (id, session_id, display_name, token) values
  ('11111111-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'Keynote speaker', 'tok-speaker-one'),
  ('11111111-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'Panel host', 'tok-speaker-two');
select public.create_agent_pairing('aaaaaaaa-0000-4000-8000-000000000001') as code \gset

-- 2. Another operator cannot see this session or make pairing codes for it.
select pg_temp.act_as('00000000-0000-4000-8000-00000000000b', false);
do $$ begin
  assert (select count(*) from public.sessions) = 0, 'foreign operator sees the session';
  assert (select count(*) from public.invites) = 0, 'foreign operator sees invites';
  begin
    perform public.create_agent_pairing('aaaaaaaa-0000-4000-8000-000000000001');
    raise exception 'foreign operator created a pairing code';
  exception when insufficient_privilege then null;
  end;
end $$;

-- 3. Speakers join with their link; a wrong link returns nothing.
select pg_temp.act_as('00000000-0000-4000-8000-000000000001', true);
do $$ begin
  assert (select count(*) from public.join_with_invite('wrong-token', 'laptop')) = 0, 'wrong token joined';
  assert (select count(*) from public.join_with_invite('tok-speaker-one', 'laptop')) = 1, 'speaker one could not join';
  -- Joining twice from the same device is harmless.
  assert (select count(*) from public.join_with_invite('tok-speaker-one', 'laptop')) = 1, 'second join failed';
  assert (select count(*) from public.sessions) = 1, 'speaker cannot read their session';
  assert (select count(*) from public.invites) = 1, 'speaker sees invites other than their own';
end $$;

select pg_temp.act_as('00000000-0000-4000-8000-000000000002', true);
do $$ begin
  assert (select count(*) from public.join_with_invite('tok-speaker-two', 'phone')) = 1, 'speaker two could not join';
end $$;

-- 4. Pairing: a wrong code returns nothing; the right one works once.
select pg_temp.act_as('00000000-0000-4000-8000-0000000000ae', true);
do $$ begin
  assert (select count(*) from public.pair_agent('000000')) = 0 or current_setting('rsc.code', true) = '000000', 'wrong code paired';
end $$;
select set_config('rsc.code', :'code', false);
do $$ begin
  assert (select count(*) from public.pair_agent(current_setting('rsc.code'))) = 1, 'agent could not pair';
  assert (select count(*) from public.pair_agent(current_setting('rsc.code'))) = 0, 'pairing code worked twice';
  assert (select count(*) from public.invites) = 2, 'agent cannot list invites';
end $$;

-- 5. Pairing is throttled per device (10 tries per 10 minutes).
select pg_temp.act_as('00000000-0000-4000-8000-000000000002', true);
do $$
declare i int;
begin
  for i in 1..10 loop
    perform public.pair_agent('999999');
  end loop;
  begin
    perform public.pair_agent('999998');
    raise exception 'pairing was not throttled';
  exception when sqlstate '54000' then null;
  end;
end $$;

-- 6. Realtime channel rules.
do $$
declare
  s text := 'aaaaaaaa-0000-4000-8000-000000000001';
  one text := '11111111-0000-4000-8000-000000000001';
  two text := '11111111-0000-4000-8000-000000000002';
begin
  -- speaker two (current user)
  assert public.rsc_topic_allowed('rsc:' || s || ':state', false), 'speaker cannot read state';
  assert not public.rsc_topic_allowed('rsc:' || s || ':state', true), 'speaker can write state';
  assert not public.rsc_topic_allowed('rsc:' || s || ':op', false), 'speaker can read op channel';
  assert public.rsc_topic_allowed('rsc:' || s || ':spk:' || two, true), 'speaker cannot write own channel';
  assert not public.rsc_topic_allowed('rsc:' || s || ':spk:' || one, false), 'speaker can read another speaker channel';
  assert not public.rsc_topic_allowed('rsc:' || s || ':spk:' || one, true), 'speaker can write another speaker channel';
  assert not public.rsc_topic_allowed('rsc:' || s || ':state:extra', false), 'malformed topic allowed';
  assert not public.rsc_topic_allowed(null, false), 'null topic allowed';
end $$;

-- The policy on realtime.messages uses realtime.topic().
select set_config('realtime.topic', 'rsc:aaaaaaaa-0000-4000-8000-000000000001:op', false);
do $$ begin
  begin
    insert into realtime.messages (topic, event, payload) values (current_setting('realtime.topic'), 'action', '{}');
    raise exception 'speaker published on the op channel';
  exception when insufficient_privilege then null;
  end;
end $$;
select set_config('realtime.topic', 'rsc:aaaaaaaa-0000-4000-8000-000000000001:spk:11111111-0000-4000-8000-000000000002', false);
insert into realtime.messages (topic, event, payload) values (current_setting('realtime.topic'), 'cmd', '{}');

select pg_temp.act_as('00000000-0000-4000-8000-0000000000ae', true);
do $$
declare s text := 'aaaaaaaa-0000-4000-8000-000000000001';
begin
  assert public.rsc_topic_allowed('rsc:' || s || ':state', true), 'agent cannot write state';
  assert public.rsc_topic_allowed('rsc:' || s || ':op', true), 'agent cannot use op channel';
  assert public.rsc_topic_allowed('rsc:' || s || ':spk:11111111-0000-4000-8000-000000000001', false), 'agent cannot hear speakers';
end $$;

-- 7. Decks and storage paths.
select pg_temp.act_as('00000000-0000-4000-8000-000000000001', true);
insert into public.decks (id, session_id, invite_id, source, file_name, storage_path)
values ('dddddddd-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
        '11111111-0000-4000-8000-000000000001', 'upload', 'talk.pptx',
        'aaaaaaaa-0000-4000-8000-000000000001/uploads/11111111-0000-4000-8000-000000000001/dddddddd-0000-4000-8000-000000000001/talk.pptx');
do $$
declare s text := 'aaaaaaaa-0000-4000-8000-000000000001';
begin
  -- A speaker cannot file a deck under someone else's invite.
  begin
    insert into public.decks (session_id, invite_id, source, file_name)
    values (s::uuid, '11111111-0000-4000-8000-000000000002', 'upload', 'x.pptx');
    raise exception 'speaker filed a deck for another invite';
  exception when insufficient_privilege then null;
  end;
  -- Nor pretend to be the agent.
  begin
    insert into public.decks (session_id, source, file_name) values (s::uuid, 'agent', 'fake.pptx');
    raise exception 'speaker created an agent deck';
  exception when insufficient_privilege then null;
  end;
  assert public.rsc_storage_allowed(s || '/uploads/11111111-0000-4000-8000-000000000001/d/talk.pptx', true), 'speaker cannot upload';
  assert not public.rsc_storage_allowed(s || '/uploads/11111111-0000-4000-8000-000000000002/d/talk.pptx', false), 'speaker reads another upload';
  assert not public.rsc_storage_allowed(s || '/previews/11111111-0000-4000-8000-000000000001/d/1.png', true), 'speaker writes previews';
  assert public.rsc_storage_allowed(s || '/previews/11111111-0000-4000-8000-000000000001/d/1.png', false), 'speaker cannot read own previews';
  assert public.rsc_storage_allowed(s || '/agent/d/1.png', false), 'speaker cannot read live slides';
  assert not public.rsc_storage_allowed(s || '/agent/d/1.png', true), 'speaker writes live slides';
  assert not public.rsc_storage_allowed('../etc/passwd', false), 'bad path allowed';
  assert not public.rsc_storage_allowed(s || '/other/x', false), 'unknown area allowed';
end $$;

select pg_temp.act_as('00000000-0000-4000-8000-0000000000ae', true);
insert into public.decks (id, session_id, source, file_name, status, slide_count, aspect, app)
values ('dddddddd-0000-4000-8000-0000000000ae', 'aaaaaaaa-0000-4000-8000-000000000001', 'agent', 'talk.pptx', 'ready', 2, 1.7778, 'powerpoint-win');
insert into public.slides (deck_id, n, image_path, notes) values
  ('dddddddd-0000-4000-8000-0000000000ae', 1, 'aaaaaaaa-0000-4000-8000-000000000001/agent/dddddddd-0000-4000-8000-0000000000ae/1.png', 'Hello'),
  ('dddddddd-0000-4000-8000-0000000000ae', 2, 'aaaaaaaa-0000-4000-8000-000000000001/agent/dddddddd-0000-4000-8000-0000000000ae/2.png', 'สวัสดี');
insert into public.click_log (session_id, source, command, result, kind)
values ('aaaaaaaa-0000-4000-8000-000000000001', 'Keynote speaker', 'next from 1·0', 'ok → 2·0', 'ok');
do $$ begin
  assert public.rsc_storage_allowed('aaaaaaaa-0000-4000-8000-000000000001/agent/x/1.png', true), 'agent cannot write slides';
  assert not public.rsc_storage_allowed('aaaaaaaa-0000-4000-8000-000000000001/uploads/11111111-0000-4000-8000-000000000001/x', true), 'agent writes uploads';
  assert (select count(*) from public.decks) = 2, 'agent cannot see all decks';
end $$;

-- Speaker two sees the live deck and its slides, but not speaker one's upload.
select pg_temp.act_as('00000000-0000-4000-8000-000000000002', true);
do $$ begin
  assert (select count(*) from public.decks) = 1, 'speaker two deck visibility wrong';
  assert (select count(*) from public.slides) = 2, 'speaker two cannot read live slides';
  assert (select notes from public.slides where n = 2) = 'สวัสดี', 'notes text mangled';
  assert (select count(*) from public.click_log) = 0, 'speaker reads the click log';
end $$;

-- 8. Host messages and acknowledgement.
select pg_temp.act_as('00000000-0000-4000-8000-00000000000a', false);
insert into public.messages (id, session_id, invite_id, text)
values ('eeeeeeee-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '11111111-0000-4000-8000-000000000001', 'Your audio is a little quiet');
do $$ begin
  assert (select count(*) from public.click_log) = 1, 'operator cannot read the click log';
  assert (select count(*) from public.session_members) = 3, 'operator does not see all members';
end $$;

-- Speaker two cannot see or ack speaker one's message.
select pg_temp.act_as('00000000-0000-4000-8000-000000000002', true);
select public.ack_message('eeeeeeee-0000-4000-8000-000000000001');
do $$ begin
  assert (select count(*) from public.messages) = 0, 'speaker two sees another speaker message';
end $$;

select pg_temp.act_as('00000000-0000-4000-8000-000000000001', true);
select public.ack_message('eeeeeeee-0000-4000-8000-000000000001');
do $$ begin
  assert (select status from public.messages) = 'seen', 'ack did not mark the message seen';
end $$;

-- 9. Google Slides links are validated.
do $$ begin
  perform public.set_google_slides_url('11111111-0000-4000-8000-000000000001', 'https://docs.google.com/presentation/d/abc/edit');
  begin
    perform public.set_google_slides_url('11111111-0000-4000-8000-000000000001', 'https://evil.example/');
    raise exception 'accepted a non-Slides link';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.set_google_slides_url('11111111-0000-4000-8000-000000000002', 'https://docs.google.com/presentation/d/x');
    raise exception 'set another speaker''s link';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;
\echo 'All access-rule tests passed.'
