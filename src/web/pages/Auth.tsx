import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { Button, Field, Input } from '../components/ui';

export function AuthPage({ mode, setupTokenRequired, onDone }: { mode: 'setup' | 'login'; setupTokenRequired: boolean; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'setup') await api('/api/auth/setup', { body: { email, password, name: name || undefined, setupToken: setupToken || undefined } });
      else await api('/api/auth/login', { body: { email, password } });
      onDone();
      if (mode === 'setup') window.history.replaceState(null, '', '/onboarding');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-panel p-6 shadow-panel">
        <div className="flex items-center gap-2.5">
          <div className="grid size-8 place-items-center rounded-lg bg-ink text-[12px] font-bold text-panel">AI</div>
          <div>
            <div className="text-[15px] font-semibold">Agency Intelligence OS</div>
            <div className="text-[12px] text-ink-3">{mode === 'setup' ? 'Create the owner account' : 'Sign in'}</div>
          </div>
        </div>
        {mode === 'setup' && (
          <Field label="Your name">
            <Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </Field>
        )}
        <Field label="E-mail">
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus />
        </Field>
        <Field label="Password" hint={mode === 'setup' ? 'At least 10 characters.' : undefined}>
          <Input type="password" required minLength={mode === 'setup' ? 10 : 1} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'setup' ? 'new-password' : 'current-password'} />
        </Field>
        {mode === 'setup' && setupTokenRequired && (
          <Field label="Setup token" hint="The SETUP_TOKEN value from the server environment.">
            <Input value={setupToken} onChange={(e) => setSetupToken(e.target.value)} required />
          </Field>
        )}
        {error && <div className="rounded-md bg-bad-soft px-3 py-2 text-[12px] text-bad">{error}</div>}
        <Button type="submit" variant="primary" className="w-full" loading={busy}>
          {mode === 'setup' ? 'Create account' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
