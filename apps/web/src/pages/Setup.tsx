import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { BUCKET, RENDERER_URL, accessToken, errorText, supabase } from '../lib/supabase';
import { resolveMembership, type Membership } from '../lib/membership';
import { newId, useShowState } from '../lib/realtime';
import { DECK_COLUMNS, safeFileName, useSlides, type DeckRow } from '../lib/slides';
import { Link } from '../lib/router';
import { Centered, CopyButton, SlideView } from '../components/ui';
import { Check, FileIcon, Upload } from '../components/Icons';

const ACCEPT = '.pptx,.ppt,.key,.pdf,.odp';

export function Setup({ sessionId }: { sessionId: string }) {
  const [me, setMe] = useState<Membership | null | undefined>(undefined);
  useEffect(() => {
    resolveMembership(sessionId).then(setMe);
  }, [sessionId]);
  if (me === undefined) return <Centered><p className="muted" style={{ margin: 0 }}>Loading…</p></Centered>;
  if (me === null) {
    return (
      <Centered>
        <h1 style={{ margin: 0, fontSize: 20 }}>Open your speaker link</h1>
        <p className="muted" style={{ margin: 0 }}>This device hasn’t joined the session yet.</p>
      </Centered>
    );
  }
  return <SetupPage me={me} />;
}

/** XHR upload so the page can show real progress (supabase-js has no progress callback). */
async function uploadWithProgress(path: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  const token = await accessToken();
  const base = (import.meta.env.VITE_SUPABASE_URL as string).replace(/\/+$/, '');
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;
  const url = `${base}/storage/v1/object/${BUCKET}/${path.split('/').map(encodeURIComponent).join('/')}`;
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('apikey', key);
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let message = `Upload failed (${xhr.status})`;
        try {
          const body = JSON.parse(xhr.responseText) as { message?: string; error?: string };
          message = body.message || body.error || message;
        } catch {
          // keep the status message
        }
        if (xhr.status === 413) message = 'This file is larger than the storage limit for your Supabase plan.';
        reject(new Error(message));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(file);
  });
}

function SetupPage({ me }: { me: Membership }) {
  const show = useShowState(me.sessionId);
  const [deck, setDeck] = useState<DeckRow | null>(null);
  const [agentDeck, setAgentDeck] = useState<DeckRow | null>(null);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadName, setUploadName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [gslides, setGslides] = useState('');
  const [gsSaved, setGsSaved] = useState(false);
  const [gsError, setGsError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadDeck = useCallback(async () => {
    const { data } = await supabase
      .from('decks')
      .select(DECK_COLUMNS)
      .eq('invite_id', me.inviteId)
      .eq('source', 'upload')
      .order('created_at', { ascending: false })
      .limit(1);
    setDeck(((data?.[0] as DeckRow | undefined) ?? null));
  }, [me.inviteId]);

  useEffect(() => {
    void loadDeck();
    supabase
      .from('invites')
      .select('google_slides_url')
      .eq('id', me.inviteId)
      .single()
      .then(({ data }) => setGslides(((data?.google_slides_url as string | null) ?? '')));
  }, [loadDeck, me.inviteId]);

  // Follow render progress live, with polling as a fallback.
  const deckIdLive = deck?.id ?? null;
  const deckSettled = !deck || deck.status === 'ready' || deck.status === 'failed' || deck.status === 'needs_agent';
  useEffect(() => {
    if (!deckIdLive || deckSettled) return;
    const channel = supabase
      .channel(`deck-${deckIdLive}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'decks', filter: `id=eq.${deckIdLive}` }, (p) => {
        setDeck(p.new as DeckRow);
      })
      .subscribe();
    const poll = setInterval(() => void loadDeck(), 4000);
    return () => {
      clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  }, [deckIdLive, deckSettled, loadDeck]);

  // The show laptop's exact export of this file, if it has opened it.
  useEffect(() => {
    if (!deck) return;
    supabase
      .from('decks')
      .select(DECK_COLUMNS)
      .eq('session_id', me.sessionId)
      .eq('source', 'agent')
      .eq('status', 'ready')
      .then(({ data }) => {
        const match = (data as DeckRow[] | null)?.find((d) => sameFile(d.file_name, deck.file_name));
        setAgentDeck(match ?? null);
      });
  }, [deck, me.sessionId, show.deckVersion]);

  const previewDeckId = agentDeck?.id ?? (deck?.status === 'ready' ? deck.id : null);
  const { slides } = useSlides(previewDeckId, show.deckVersion);

  async function startUpload(file: File) {
    setError(null);
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!['pptx', 'ppt', 'key', 'pdf', 'odp'].includes(ext)) {
      setError('Use a PowerPoint (.pptx), Keynote (.key) or PDF file.');
      return;
    }
    const deckId = newId();
    const path = `${me.sessionId}/uploads/${me.inviteId}/${deckId}/${safeFileName(file.name)}`;
    setUploadName(file.name);
    setUploadPct(0);
    try {
      await uploadWithProgress(path, file, setUploadPct);
      const { error: insertError } = await supabase.from('decks').insert({
        id: deckId,
        session_id: me.sessionId,
        invite_id: me.inviteId,
        source: 'upload',
        file_name: file.name,
        storage_path: path,
        status: 'uploaded',
      });
      if (insertError) throw insertError;
      await loadDeck();
      if (RENDERER_URL) {
        const token = await accessToken();
        const res = await fetch(`${RENDERER_URL}/render`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ deck_id: deckId }),
        });
        if (!res.ok) throw new Error(`Preview service answered ${res.status}`);
      }
      await loadDeck();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setUploadPct(null);
      setUploadName(null);
    }
  }

  async function saveGoogleSlides() {
    setGsError(null);
    setGsSaved(false);
    const { error } = await supabase.rpc('set_google_slides_url', { p_invite: me.inviteId, p_url: gslides });
    if (error) setGsError(error.message.includes('Google') ? 'Paste a link that starts with https://docs.google.com/presentation/' : errorText(error));
    else setGsSaved(true);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void startUpload(f);
  }

  const st = show.state;
  const openOnLaptop = Boolean(deck && st?.deck?.fileName && sameFile(st.deck.fileName, deck.file_name));
  const presenterLink = `${location.origin}/s/${me.sessionId}`;

  const steps = deck
    ? [
        { label: 'Upload', detail: 'done', state: 'done' as const },
        {
          label: 'Render slide previews',
          detail: deck.status === 'ready' ? `${deck.slide_count ?? slides.length} slides` : deck.status === 'rendering' ? `${deck.progress}%` : deck.status === 'failed' ? 'failed' : RENDERER_URL ? 'queued' : 'on the show laptop',
          state: deck.status === 'ready' ? ('done' as const) : deck.status === 'rendering' ? ('active' as const) : ('wait' as const),
          progress: deck.status === 'rendering' ? deck.progress : null,
        },
        {
          label: 'Read speaker notes',
          detail: deck.status === 'ready' ? `${slides.filter((s) => s.notes).length} of ${slides.length} slides` : '–',
          state: deck.status === 'ready' ? ('done' as const) : ('wait' as const),
        },
      ]
    : [];

  return (
    <div className="page">
      <header className="topbar">
        <div className="who">
          <span className="role-tag">Speaker setup</span>
          <div>
            <div className="title">
              {me.room ? `${me.room} · ` : ''}
              {me.sessionName}
            </div>
            <div className="sub">{me.displayName}</div>
          </div>
        </div>
        <Link to={`/s/${me.sessionId}`} className="btn">Open presenter view</Link>
      </header>

      <main className="main narrow">
        <section className="col-main">
          <div className="card">
            <h2 style={{ margin: 0, fontSize: 17 }}>1 · Upload your deck</h2>
            {uploadPct !== null ? (
              <div className="well" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{uploadName}</span>
                  <span className="mono faint">{uploadPct}%</span>
                </div>
                <div className="progress"><div style={{ width: `${uploadPct}%` }} /></div>
              </div>
            ) : deck ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div className="row well">
                  <FileIcon size={26} style={{ color: 'var(--text-2)' }} />
                  <div className="grow">
                    <div style={{ fontWeight: 500 }}>{deck.file_name}</div>
                    <div className="faint" style={{ fontSize: 12 }}>Uploaded {new Date(deck.created_at).toLocaleString()}</div>
                  </div>
                  <button className="btn small" onClick={() => fileInput.current?.click()}>Replace file</button>
                </div>
                <div className="steps">
                  {steps.map((s) => (
                    <div key={s.label} className={`step ${s.state}`}>
                      <span className="mark">{s.state === 'done' ? <Check size={13} /> : null}</span>
                      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
                        <div className="row" style={{ justifyContent: 'space-between' }}>
                          <span>{s.label}</span>
                          <span className="mono faint" style={{ fontSize: 12 }}>{s.detail}</span>
                        </div>
                        {'progress' in s && s.progress !== null && s.progress !== undefined ? (
                          <div className="progress"><div style={{ width: `${s.progress}%` }} /></div>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
                {deck.status === 'failed' ? (
                  <div className="field-error">The preview couldn’t be made{deck.error ? ` (${deck.error})` : ''}. The show laptop will still render it exactly once it opens the file.</div>
                ) : null}
                {deck.status === 'needs_agent' ? (
                  <div className="chip warn" style={{ whiteSpace: 'normal' }}>This format is previewed by the show laptop once the operator opens it.</div>
                ) : null}
              </div>
            ) : (
              <button
                className={`dropzone ${drag ? 'drag' : ''}`}
                onClick={() => fileInput.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDrag(true);
                }}
                onDragLeave={() => setDrag(false)}
                onDrop={onDrop}
              >
                <Upload size={32} style={{ color: 'var(--accent)' }} />
                <span style={{ fontSize: 16, fontWeight: 500 }}>Drop your file here, or choose a file</span>
                <span className="muted" style={{ fontSize: 13 }}>PowerPoint .pptx · Keynote .key · PDF</span>
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT}
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void startUpload(f);
              }}
            />
            {error ? <div className="field-error" role="alert">{error}</div> : null}

            <div className="row faint" style={{ fontSize: 12 }}>
              <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
              or
              <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
            </div>
            <div>
              <label className="label" htmlFor="gs">Google Slides link</label>
              <div className="row">
                <input
                  id="gs"
                  className="input grow"
                  type="url"
                  placeholder="https://docs.google.com/presentation/d/…"
                  value={gslides}
                  onChange={(e) => {
                    setGslides(e.target.value);
                    setGsSaved(false);
                    setGsError(null);
                  }}
                />
                <button className="btn" onClick={saveGoogleSlides}>Save link</button>
              </div>
              {gsError ? <div className="field-error">{gsError}</div> : null}
              {gsSaved ? <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Saved. Share the deck with the show team so they can present it.</div> : null}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2 style={{ margin: 0, fontSize: 17 }}>2 · Check your slides and notes</h2>
              {slides.length ? (
                <span className={`chip ${agentDeck ? 'ok' : 'warn'}`}>
                  <span className="dot" />
                  {agentDeck ? 'Exact render from the show laptop' : 'Server preview · fonts may differ slightly'}
                </span>
              ) : null}
            </div>
            {slides.length ? (
              <div className="thumb-grid">
                {slides.map((s) => (
                  <div key={s.n} style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                    <SlideView url={s.url} aspect={agentDeck?.aspect || deck?.aspect || 16 / 9} number={s.n} title={s.title} />
                    <div className="row" style={{ fontSize: 12, flexWrap: 'nowrap' }}>
                      <span className="mono faint">{s.n}</span>
                      <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title ?? ''}</span>
                      {s.notes ? <span className="chip neutral">notes</span> : null}
                      {s.builds ? <span className="chip info">{s.builds} builds</span> : null}
                      {s.hidden ? <span className="chip neutral">hidden</span> : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="well faint" style={{ minHeight: 140, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}>
                Slide previews and notes appear here after upload
              </div>
            )}
          </div>
        </section>

        <aside className="col-side">
          <div className="card">
            <h2 style={{ margin: 0, fontSize: 17 }}>3 · On the show laptop</h2>
            <div className="steps">
              <VenueStep done={Boolean(deck)} active={false} label="File sent to the show team" sub={deck ? 'Available in the operator console' : 'After upload'} />
              <VenueStep
                done={openOnLaptop}
                active={Boolean(deck) && !openOnLaptop}
                label="Opened on the show laptop"
                sub={openOnLaptop ? `${st?.app === 'keynote' ? 'Keynote' : 'PowerPoint'} · agent connected` : deck ? 'Waiting for the operator' : '–'}
              />
              <VenueStep done={Boolean(agentDeck)} active={false} label="Previews replaced with an exact render" sub={agentDeck ? 'Slides and notes re-exported from the app' : 'Happens automatically'} />
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.55 }}>
              The server preview arrives in seconds. Once the operator opens your file, the show laptop re-exports every slide and note from the presentation app itself, so what you see matches what the audience sees.
            </p>
          </div>
          <div className="card">
            <h2 style={{ margin: 0, fontSize: 17 }}>4 · On show day</h2>
            <span className="muted">Open your invite link on any browser. Nothing to install.</span>
            <div className="well" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span className="faint" style={{ fontSize: 12 }}>Presenter view on this device</span>
              <span className="mono" style={{ fontSize: 12, wordBreak: 'break-all' }}>{presenterLink}</span>
            </div>
            <div className="row">
              <Link to={`/s/${me.sessionId}`} className="btn primary grow">Open presenter view</Link>
              <CopyButton text={presenterLink} />
            </div>
            <span className="faint" style={{ fontSize: 12 }}>On another device (like your phone), open the original invite link instead.</span>
          </div>
        </aside>
      </main>
    </div>
  );
}

function VenueStep({ done, active, label, sub }: { done: boolean; active: boolean; label: string; sub: string }) {
  return (
    <div className={`step ${done ? 'done' : active ? 'active' : ''}`}>
      <span className="mark">{done ? <Check size={13} /> : null}</span>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span>{label}</span>
        <span className="faint" style={{ fontSize: 12 }}>{sub}</span>
      </div>
    </div>
  );
}

function sameFile(a: string, b: string): boolean {
  const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/\.(pptx?|key|pdf|odp)$/i, '').trim();
  return norm(a) === norm(b);
}
