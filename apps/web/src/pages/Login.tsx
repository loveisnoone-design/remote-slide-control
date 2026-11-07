import { useState, type FormEvent } from 'react';
import { errorText, supabase } from '../lib/supabase';
import { navigate } from '../lib/router';
import { Centered } from '../components/ui';

export function Login() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!email.includes('@')) return setError('Enter your email address');
    if (password.length < 8) return setError('Use at least 8 characters for the password');
    setBusy(true);
    try {
      // Signing in replaces any anonymous speaker session in this browser.
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        navigate('/op', true);
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: `${location.origin}/op` } });
        if (error) throw error;
        if (data.session) navigate('/op', true);
        else setNotice('Check your email to confirm the account, then sign in.');
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function magicLink() {
    setError(null);
    if (!email.includes('@')) return setError('Enter your email address first');
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: `${location.origin}/op`, shouldCreateUser: false } });
    setBusy(false);
    if (error) setError(errorText(error));
    else setNotice('Sign-in link sent. Open it on this device.');
  }

  return (
    <Centered>
      <span className="role-tag neutral" style={{ alignSelf: 'flex-start' }}>Operator</span>
      <h1 style={{ margin: 0, fontSize: 20 }}>{mode === 'signin' ? 'Sign in' : 'Create an operator account'}</h1>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }} noValidate>
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error ? <div className="field-error" role="alert">{error}</div> : null}
        {notice ? <div className="chip ok" style={{ whiteSpace: 'normal' }}>{notice}</div> : null}
        <button className="btn primary" type="submit" disabled={busy}>{mode === 'signin' ? 'Sign in' : 'Create account'}</button>
      </form>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <button className="btn ghost small" onClick={() => setMode(mode === 'signin' ? 'signup' : 'signin')}>
          {mode === 'signin' ? 'New here? Create an account' : 'Have an account? Sign in'}
        </button>
        {mode === 'signin' ? <button className="btn ghost small" onClick={magicLink} disabled={busy}>Email me a link</button> : null}
      </div>
    </Centered>
  );
}
