-- The rsc_* helper functions back the access rules. Signed-in users need
-- EXECUTE (policies run as the caller), but visitors who are not signed in
-- never do, so they are not callable through the public API.

revoke execute on function
  public.rsc_is_owner(uuid),
  public.rsc_is_agent(uuid),
  public.rsc_is_member(uuid),
  public.rsc_has_invite(uuid),
  public.rsc_invite_in_session(uuid, uuid),
  public.rsc_topic_allowed(text, boolean),
  public.rsc_storage_allowed(text, boolean)
from public, anon;

grant execute on function
  public.rsc_is_owner(uuid),
  public.rsc_is_agent(uuid),
  public.rsc_is_member(uuid),
  public.rsc_has_invite(uuid),
  public.rsc_invite_in_session(uuid, uuid),
  public.rsc_topic_allowed(text, boolean),
  public.rsc_storage_allowed(text, boolean)
to authenticated, service_role;
