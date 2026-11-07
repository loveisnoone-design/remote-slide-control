import { useAuth } from '../lib/auth';
import { Link } from '../lib/router';
import { Centered } from '../components/ui';

export function Home() {
  const { isOperator, loading } = useAuth();
  return (
    <Centered>
      <span className="role-tag" style={{ alignSelf: 'flex-start' }}>Slide Relay</span>
      <h1 style={{ margin: 0, fontSize: 22 }}>Remote slide control for hybrid shows</h1>
      <p className="muted" style={{ margin: 0 }}>
        Speakers join from any browser with the link they were sent. The show team runs the session from the operator console.
      </p>
      {loading ? null : isOperator ? (
        <Link to="/op" className="btn primary">Open your sessions</Link>
      ) : (
        <Link to="/login" className="btn primary">Operator sign in</Link>
      )}
      <p className="faint" style={{ margin: 0, fontSize: 13 }}>Speaker? Open the invite link from your email — no account needed.</p>
    </Centered>
  );
}
