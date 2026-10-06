'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button, Field, Input } from '@/components/ui';

export default function LoginPage() {
  const router = useRouter();
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ email: '', password: '', name: 'Prince Gupta' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ registrationOpen: boolean }>('/auth/status')
      .then((s) => {
        setRegistrationOpen(s.registrationOpen);
        if (s.registrationOpen) setMode('register');
      })
      .catch(() => undefined);
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(`/auth/${mode}`, { body: mode === 'login' ? { email: form.email, password: form.password } : form });
      router.replace('/');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-lg font-semibold">Career Outreach</h1>
        <p className="mt-1 text-sm text-ink-muted">{mode === 'register' ? 'First run — create your account.' : 'Sign in to your command center.'}</p>
        <form onSubmit={submit} className="mt-6 space-y-4 rounded-lg border border-slate-200 bg-white p-5">
          {mode === 'register' && (
            <Field label="Name">
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
            </Field>
          )}
          <Field label="Email">
            <Input type="email" autoComplete="username" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required />
          </Field>
          <Field label="Password" hint={mode === 'register' ? 'At least 10 characters. This is your app password — never your Gmail password.' : undefined}>
            <Input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required />
          </Field>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <Button type="submit" variant="primary" className="w-full" loading={busy}>
            {mode === 'register' ? 'Create account' : 'Sign in'}
          </Button>
          {registrationOpen && (
            <button type="button" className="w-full text-xs text-ink-muted hover:text-ink" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? 'Create an account instead' : 'I already have an account'}
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
