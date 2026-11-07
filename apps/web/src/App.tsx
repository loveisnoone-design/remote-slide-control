import { match, usePath } from './lib/router';
import { isConfigured } from './lib/supabase';
import { Centered } from './components/ui';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { Sessions } from './pages/Sessions';
import { OperatorConsole } from './pages/Operator';
import { Join } from './pages/Join';
import { Presenter } from './pages/Presenter';
import { Setup } from './pages/Setup';

export function App() {
  const path = usePath();

  if (!isConfigured) {
    return (
      <Centered>
        <h1 style={{ margin: 0, fontSize: 20 }}>Not configured yet</h1>
        <p className="muted" style={{ margin: 0 }}>
          Set <span className="mono">VITE_SUPABASE_URL</span> and <span className="mono">VITE_SUPABASE_ANON_KEY</span> in
          <span className="mono"> apps/web/.env</span>, then restart the dev server. See the README.
        </p>
      </Centered>
    );
  }

  let m: Record<string, string> | null;
  if (path === '/' || path === '') return <Home />;
  if (path === '/login') return <Login />;
  if (path === '/op') return <Sessions />;
  if ((m = match('/op/:sessionId', path))) return <OperatorConsole sessionId={m.sessionId!} />;
  if ((m = match('/join/:token', path))) return <Join token={m.token!} />;
  if ((m = match('/s/:sessionId/setup', path))) return <Setup sessionId={m.sessionId!} />;
  if ((m = match('/s/:sessionId', path))) return <Presenter sessionId={m.sessionId!} />;

  return (
    <Centered>
      <h1 style={{ margin: 0, fontSize: 20 }}>Page not found</h1>
      <a href="/">Go to the start page</a>
    </Centered>
  );
}
