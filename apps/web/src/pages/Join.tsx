import { useEffect, useState } from 'react';
import { ensureSignedIn, errorText, supabase } from '../lib/supabase';
import { deviceLabel, saveMembership, type Membership } from '../lib/membership';
import { Link } from '../lib/router';
import { Centered } from '../components/ui';

export function Join({ token }: { token: string }) {
  const [state, setState] = useState<'working' | 'bad' | 'error' | 'ok'>('working');
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<Membership | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await ensureSignedIn();
        const { data, error } = await supabase.rpc('join_with_invite', { p_token: token, p_device: deviceLabel() });
        if (error) throw error;
        const row = (data as Array<{ session_id: string; invite_id: string; display_name: string; session_name: string; room: string | null }> | null)?.[0];
        if (!alive) return;
        if (!row) {
          setState('bad');
          return;
        }
        const m: Membership = {
          sessionId: row.session_id,
          inviteId: row.invite_id,
          displayName: row.display_name,
          sessionName: row.session_name,
          room: row.room,
        };
        saveMembership(m);
        setMe(m);
        setState('ok');
      } catch (e) {
        if (!alive) return;
        setError(errorText(e));
        setState('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  if (state === 'working') return <Centered><p className="muted" style={{ margin: 0 }}>Opening your invite…</p></Centered>;
  if (state === 'bad') {
    return (
      <Centered>
        <h1 style={{ margin: 0, fontSize: 20 }}>This link doesn’t work</h1>
        <p className="muted" style={{ margin: 0 }}>It may have been replaced or switched off. Ask the show team for a new one.</p>
      </Centered>
    );
  }
  if (state === 'error' || !me) {
    return (
      <Centered>
        <h1 style={{ margin: 0, fontSize: 20 }}>Couldn’t open the invite</h1>
        <p className="field-error" style={{ margin: 0 }}>{error}</p>
        <p className="muted" style={{ margin: 0 }}>If anonymous sign-in is switched off in Supabase, the show team needs to turn it on.</p>
      </Centered>
    );
  }
  return (
    <Centered>
      <span className="role-tag" style={{ alignSelf: 'flex-start' }}>Speaker</span>
      <h1 style={{ margin: 0, fontSize: 20 }}>Hi {me.displayName}</h1>
      <p className="muted" style={{ margin: 0 }}>
        {me.sessionName}
        {me.room ? ` · ${me.room}` : ''}
      </p>
      <Link to={`/s/${me.sessionId}/setup`} className="btn">Prepare your slides</Link>
      <Link to={`/s/${me.sessionId}`} className="btn primary">Open presenter view</Link>
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>
        On show day, open this same link on your laptop or phone. Keep it private: it controls your slides.
      </p>
    </Centered>
  );
}
