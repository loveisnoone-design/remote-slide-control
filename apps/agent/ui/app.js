/* global window, document */
'use strict';

const api = window.rsc;
const $ = (id) => document.getElementById(id);

const APP_LABEL = {
  'powerpoint-win': 'PowerPoint (Windows · COM)',
  'powerpoint-mac': 'PowerPoint (Mac · AppleScript)',
  keynote: 'Keynote (AppleScript / JXA)',
  keys: 'Keystroke mode',
  none: 'Not detected — open PowerPoint or Keynote',
};

let lastStatus = null;
let settingsLoaded = false;

function render(s) {
  lastStatus = s;
  $('configure').hidden = s.configured;
  $('pairing').hidden = !s.configured || Boolean(s.session);
  $('live').hidden = !s.session;

  $('session-line').textContent = s.session ? `${s.session.room ? `${s.session.room} · ` : ''}${s.session.name}` : s.configured ? 'Not paired' : 'Not set up';

  const pill = $('link-pill');
  const map = {
    live: ['ok', 'Connected'],
    connecting: ['wait', 'Connecting…'],
    error: ['bad', 'Connection problem'],
    unauthorized: ['bad', 'Pairing removed — pair again'],
    idle: ['wait', 'Idle'],
  };
  const [cls, text] = map[s.link] || map.idle;
  pill.className = `pill ${cls}`;
  $('link-text').textContent = text;

  if (!s.session) return;
  const st = s.state;
  $('v-app').textContent = st ? APP_LABEL[st.app] || st.app : '–';
  $('v-file').textContent = st && st.deck ? `${st.deck.fileName} · ${st.deck.slideCount} slides` : 'No presentation open';
  $('v-show').textContent = st ? (st.inShow ? (st.blank ? 'Running · screen blank' : 'Running') : 'Not running') : '–';
  const pos = st && st.pos ? `${st.pos.slide}${st.pos.build !== null ? ` · build ${st.pos.build}` : ''}${st.posEstimated ? ' (estimated)' : ''}` : '–';
  $('v-pos').textContent = pos;
  $('v-control').textContent = st ? (st.locked ? 'Locked by operator' : st.controller ? `${s.speakerName || 'Speaker'} has control` : 'Operator only') : '–';

  const ex = s.export;
  let exText = 'Waiting for a presentation';
  if (ex) {
    if (ex.phase === 'exporting') exText = `Exporting from the app…`;
    else if (ex.phase === 'uploading') exText = `Uploading ${ex.done} / ${ex.total}`;
    else if (ex.phase === 'done') exText = `Ready · ${ex.total} slides`;
    else if (ex.phase === 'failed') exText = `Failed: ${ex.error}`;
    else if (ex.phase === 'waiting_for_show_end') exText = 'Waits until the slideshow stops (Keynote/Mac can’t export while playing)';
  }
  if (st && st.deck && st.deck.deckId && (!ex || ex.phase === 'idle')) exText = 'Ready (previous export)';
  $('v-export').textContent = exText;

  const err = $('app-error');
  err.hidden = !s.appError;
  err.textContent = s.appError ? `Presentation app: ${s.appError}` : '';
  $('ax-warning').hidden = !(s.platform === 'darwin' && !s.accessibility);
  $('protected-hint').hidden = s.platform !== 'win32';

  $('log').textContent = (s.log || []).join('\n');

  if (!settingsLoaded) {
    settingsLoaded = true;
    const c = s.settings;
    $('app-mode').value = c.appMode;
    $('export-width').value = String(c.exportWidth);
    $('http-on').checked = c.httpEnabled;
    $('http-port').value = String(c.httpPort);
    $('osc-on').checked = c.oscEnabled;
    $('osc-port').value = String(c.oscPort);
    $('lan-on').checked = c.lan;
    $('token').textContent = c.token;
    void loadDisplays(c.overlayDisplayId);
    void loadDecks();
  }
  $('keys-box').hidden = $('app-mode').value !== 'keys';
  const sc = st && st.showControl;
  $('sc-example').textContent = sc && sc.httpPort
    ? `curl -X POST http://${sc.lan ? '<this-laptop-ip>' : '127.0.0.1'}:${sc.httpPort}/api/next${sc.lan ? ` -H "X-RSC-Token: ${s.settings.token}"` : ''}   ·   OSC /next /back /goto <n> /blank on udp ${sc.oscPort ?? '–'}`
    : '';
}

async function loadDisplays(selected) {
  const sel = $('overlay-display');
  const displays = await api.displays();
  sel.textContent = '';
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = 'Automatic (external display)';
  sel.appendChild(auto);
  for (const d of displays) {
    const o = document.createElement('option');
    o.value = String(d.id);
    o.textContent = d.label;
    sel.appendChild(o);
  }
  sel.value = selected === null || selected === undefined ? '' : String(selected);
}

async function loadDecks() {
  const list = $('decks');
  const decks = await api.decks();
  list.textContent = '';
  if (!decks.length) {
    const li = document.createElement('li');
    li.textContent = 'No uploads yet.';
    list.appendChild(li);
    return;
  }
  for (const d of decks) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = `${d.speaker}: ${d.fileName}`;
    li.appendChild(name);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Download & open';
    btn.disabled = !d.hasFile;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Downloading…';
      const r = await api.openDeck(d.id);
      btn.textContent = r.ok ? 'Opened' : 'Try again';
      btn.disabled = false;
      if (!r.ok) window.alert(r.error || 'Could not open the file');
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

$('configure-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('configure-error').textContent = '';
  const r = await api.configure({ supabaseUrl: $('sb-url').value, anonKey: $('sb-key').value });
  if (!r.ok) $('configure-error').textContent = r.error;
  render(await api.status());
});

$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('pair-error').textContent = '';
  const code = $('pair-code').value.replace(/\D/g, '');
  if (code.length !== 6) {
    $('pair-error').textContent = 'Type the 6-digit code from the operator console.';
    return;
  }
  const btn = e.submitter || null;
  if (btn) btn.disabled = true;
  const r = await api.pair(code);
  if (btn) btn.disabled = false;
  if (!r.ok) $('pair-error').textContent = r.error;
  settingsLoaded = false;
  render(await api.status());
});

$('pair-code').addEventListener('input', () => {
  $('pair-error').textContent = '';
});

$('change-project').addEventListener('click', () => {
  $('configure').hidden = false;
  $('sb-url').value = lastStatus ? lastStatus.supabaseUrl : '';
});

$('resync').addEventListener('click', () => api.resync());
$('test-laser').addEventListener('click', () => api.testLaser());
$('ask-ax').addEventListener('click', () => api.askAccessibility());
$('refresh-decks').addEventListener('click', () => loadDecks());
$('app-mode').addEventListener('change', () => {
  $('keys-box').hidden = $('app-mode').value !== 'keys';
});
$('keys-apply').addEventListener('click', () =>
  api.keysReset({ slide: Number($('keys-slide').value) || 1, slideCount: Number($('keys-count').value) || 0 }),
);

$('save-settings').addEventListener('click', async () => {
  const displayVal = $('overlay-display').value;
  await api.settings({
    appMode: $('app-mode').value,
    overlayDisplayId: displayVal === '' ? null : Number(displayVal),
    exportWidth: Number($('export-width').value),
    httpEnabled: $('http-on').checked,
    httpPort: Number($('http-port').value),
    oscEnabled: $('osc-on').checked,
    oscPort: Number($('osc-port').value),
    lan: $('lan-on').checked,
  });
  $('settings-saved').textContent = 'Saved';
  setTimeout(() => ($('settings-saved').textContent = ''), 1500);
});

$('unpair').addEventListener('click', async () => {
  if (!window.confirm('Unpair this laptop? Remote speakers will lose control until you pair again.')) return;
  await api.unpair();
  settingsLoaded = false;
  render(await api.status());
});

api.onStatus(render);
api.status().then(render);
