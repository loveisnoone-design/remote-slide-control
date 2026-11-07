import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { errorText, supabase } from '../lib/supabase';
import { Link, navigate } from '../lib/router';
import { Centered, CopyButton } from '../components/ui';

interface SessionRow {
  id: string;
  name: string;
  room: string | null;
  talk_length_sec: number;
  created_at: string;
}

interface InviteRow {
  id: string;
  session_id: string;
  display_name: string;
  token: string;
  revoked: boolean;
}

export function inviteLink(token: string): string {
  return `${location.origin}/join/${token}`;
}

export function Sessions() {
  const { user, loading, isOperator } = useAuth();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    const [{ data: s, error: e1 }, { data: i, error: e2 }] = await Promise.all([
      supabase.from('sessions').select('id, name, room, talk_length_sec, created_at').eq('owner', user.id).order('created_at', { ascending: false }),
      supabase.from('invites').select('id, session_id, display_name, token, revoked').order('created_at'),
    ]);
    if (e1 || e2) setError(errorText(e1 ?? e2));
    setSessions((s as SessionRow[]) ?? []);
    setInvites((i as InviteRow[]) ?? []);
  }, [user]);

  useEffect(() => {
    if (isOperator) void load();
  }, [isOperator, load]);

  if (loading) return null;
  if (!isOperator) {
    return (
      <Centered>
        <h1 style={{ margin: 0, fontSize: 20 }}>Operator sign in needed</h1>
        <Link to="/login" className="btn primary">Sign in</Link>
      </Centered>
    );
  }

  return (
    <div className="page">
      <header className="topbar">
        <div className="who">
          <span className="role-tag neutral">Operator</span>
          <div>
            <div className="title">Your sessions</div>
            <div className="sub">{user?.email}</div>
          </div>
        </div>
        <button
          className="btn small"
          onClick={async () => {
            await supabase.auth.signOut();
            navigate('/', true);
          }}
        >
          Sign out
        </button>
      </header>
      <main className="main narrow" style={{ flexDirection: 'column', flexWrap: 'nowrap' }}>
        {error ? <div className="field-error" role="alert">{error}</div> : null}
        <NewSession onCreated={(id) => navigate(`/op/${id}`)} />
        {sessions.length === 0 ? <p className="muted">No sessions yet. Create one above for each talk or hall.</p> : null}
        {sessions.map((s) => (
          <SessionCard key={s.id} session={s} invites={invites.filter((i) => i.session_id === s.id)} onChange={load} />
        ))}
      </main>
    </div>
  );
}

function NewSession({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [room, setRoom] = useState('');
  const [minutes, setMinutes] = useState(20);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Give the session a name');
    if (!(minutes >= 1 && minutes <= 600)) return setError('Talk length must be between 1 and 600 minutes');
    setBusy(true);
    const { data, error } = await supabase
      .from('sessions')
      .insert({ name: name.trim(), room: room.trim() || null, talk_length_sec: Math.round(minutes * 60) })
      .select('id')
      .single();
    setBusy(false);
    if (error || !data) return setError(errorText(error));
    onCreated(data.id as string);
  }

  return (
    <form className="card" onSubmit={submit} noValidate>
      <span className="eyebrow">New session</span>
      <div className="row">
        <div className="grow">
          <label className="label" htmlFor="s-name">Name</label>
          <input id="s-name" className="input" placeholder="Opening keynote" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grow">
          <label className="label" htmlFor="s-room">Room</label>
          <input id="s-room" className="input" placeholder="Hall A" value={room} onChange={(e) => setRoom(e.target.value)} />
        </div>
        <div style={{ width: 140 }}>
          <label className="label" htmlFor="s-len">Talk length (min)</label>
          <input id="s-len" className="input mono" type="number" min={1} max={600} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
        </div>
      </div>
      {error ? <div className="field-error" role="alert">{error}</div> : null}
      <div><button className="btn primary" type="submit" disabled={busy}>Create session</button></div>
    </form>
  );
}

function SessionCard({ session, invites, onChange }: { session: SessionRow; invites: InviteRow[]; onChange: () => void }) {
  const [speaker, setSpeaker] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function addInvite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!speaker.trim()) return setError('Type the speaker’s name');
    const { error } = await supabase.from('invites').insert({ session_id: session.id, display_name: speaker.trim() });
    if (error) return setError(errorText(error));
    setSpeaker('');
    onChange();
  }

  async function revoke(inv: InviteRow) {
    if (!window.confirm(`Revoke the link for ${inv.display_name}? Their devices stay joined until you remove them in the console.`)) return;
    await supabase.from('invites').update({ revoked: true }).eq('id', inv.id);
    onChange();
  }

  return (
    <section className="card" aria-label={session.name}>
      <div className="card-head">
        <div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{session.name}</div>
          <div className="faint" style={{ fontSize: 13 }}>
            {session.room ? `${session.room} · ` : ''}
            {Math.round(session.talk_length_sec / 60)} min
          </div>
        </div>
        <Link to={`/op/${session.id}`} className="btn primary">Open console</Link>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span className="eyebrow">Speaker links</span>
        {invites.length === 0 ? <span className="faint" style={{ fontSize: 13 }}>Add each speaker to get a personal link to send them.</span> : null}
        {invites.map((inv) => (
          <div key={inv.id} className="row well" style={{ padding: '8px 10px' }}>
            <span className="grow" style={{ fontWeight: 500 }}>
              {inv.display_name}
              {inv.revoked ? <span className="chip neutral" style={{ marginLeft: 8 }}>revoked</span> : null}
            </span>
            {!inv.revoked ? (
              <>
                <CopyButton text={inviteLink(inv.token)} />
                <button className="btn small ghost" onClick={() => revoke(inv)}>Revoke</button>
              </>
            ) : null}
          </div>
        ))}
        <form className="row" onSubmit={addInvite} noValidate>
          <label className="sr-only" htmlFor={`inv-${session.id}`}>Speaker name</label>
          <input id={`inv-${session.id}`} className="input grow" placeholder="Speaker name" value={speaker} onChange={(e) => setSpeaker(e.target.value)} />
          <button className="btn" type="submit">Add speaker</button>
        </form>
        {error ? <div className="field-error" role="alert">{error}</div> : null}
      </div>
    </section>
  );
}
