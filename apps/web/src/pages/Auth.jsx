import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { LockKeyhole, ArrowRight, MailCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export function AuthPage({ register = false }) {
  const auth = useAuth(), navigate = useNavigate(), [params] = useSearchParams();
  const [name, setName] = useState(''), [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [challenge, setChallenge] = useState(null), [code, setCode] = useState(''), [now, setNow] = useState(Date.now());
  const next = params.get('next');
  const safeNext = next?.startsWith('/') && !next.startsWith('//') && !next.includes(String.fromCharCode(92)) ? next : '/';
  useEffect(() => { setChallenge(null); setCode(''); setError(''); setMessage(''); setPassword(''); }, [register]);
  useEffect(() => { if (!challenge) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [challenge]);
  const resendSeconds = challenge ? Math.max(0, Math.ceil((new Date(challenge.resend_after).getTime() - now) / 1000)) : 0;
  const expired = challenge && new Date(challenge.expires_at).getTime() <= now;
  function finish(user) { navigate(user.role === 'restaurant' ? '/console' : user.role === 'partner' ? '/partner' : user.role === 'admin' ? '/admin' : safeNext, { replace: true }); }
  async function submit(e) {
    e.preventDefault(); if (busy) return; setBusy(true); setError(''); setMessage('');
    try {
      if (register && !challenge) {
        const pending = await auth.register(name, email, password);
        setChallenge(pending); setNow(Date.now()); setPassword(''); setCode('');
      } else if (register) finish(await auth.verifySignup(challenge.challenge_id, code));
      else finish(await auth.login(email, password));
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function resend() {
    if (busy || resendSeconds || expired) return;
    setBusy(true); setError(''); setMessage('');
    try { setChallenge(await auth.resendSignup(challenge.challenge_id)); setNow(Date.now()); setCode(''); setMessage('A new verification code was sent. Use the latest email.'); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  function startAgain() { setChallenge(null); setCode(''); setPassword(''); setError(''); setMessage(''); }
  return <div className="content-width max-w-xl py-14"><div className="panel p-7 md:p-10">
    <div className="bg-peach rounded-2xl text-coral w-12 h-12 grid place-items-center">{challenge ? <MailCheck/> : <LockKeyhole/>}</div>
    <p className="eyebrow mt-6">YOUR COMBOROUTE ACCOUNT</p>
    <h1 className="font-outfit text-3xl font-black mt-2">{register ? challenge ? 'Verify your email' : 'Create customer account' : 'Welcome back'}</h1>
    <p className="text-muted text-sm mt-2">{challenge ? `Enter the six-digit code sent to ${email}. Your account will be created after verification.` : register ? 'Verify your email to create a customer account. Restaurant and delivery partner accounts are issued by an administrator.' : 'Sign in to see your orders and access your authorized dashboard.'}</p>
    <form className="space-y-4 mt-7" onSubmit={submit}>
      {register && !challenge && <label className="block text-sm font-bold">Full name<input disabled={busy} required minLength={2} maxLength={80} autoComplete="name" className="field mt-2" value={name} onChange={e => setName(e.target.value)}/></label>}
      {!challenge && <><label className="block text-sm font-bold">Email<input disabled={busy} type="email" required maxLength={200} autoComplete="email" className="field mt-2" value={email} onChange={e => setEmail(e.target.value)}/></label>
      <label className="block text-sm font-bold">Password<input disabled={busy} type="password" required minLength={register ? 12 : 1} maxLength={128} autoComplete={register ? 'new-password' : 'current-password'} className="field mt-2" value={password} onChange={e => setPassword(e.target.value)}/></label></>}
      {register && !challenge && <p className="text-xs text-muted">Use at least 12 characters. Never reuse your MongoDB or Razorpay passwords.</p>}
      {challenge && <><label className="block text-sm font-bold">Verification code<input disabled={busy || expired} required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} className="field mt-2 tracking-widest" value={code} onChange={e => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}/></label>
      <p className="text-xs text-muted">{expired ? 'This code has expired. Start signup again to request a new code.' : 'The code expires in 10 minutes. Check your spam folder if the email is missing.'}</p></>}
      {error && <p role="alert" className="bg-red-50 text-red-800 p-3 rounded-xl text-sm">{error}</p>}
      {message && <p role="status" className="bg-green-50 text-green-800 p-3 rounded-xl text-sm">{message}</p>}
      <button disabled={busy || !!expired} className="btn-primary w-full justify-between">{busy ? 'Please wait...' : register ? challenge ? 'Verify email & create account' : 'Send verification code' : 'Sign in'} <ArrowRight size={17}/></button>
    </form>
    {challenge && <div className="flex flex-wrap gap-3 mt-4"><button type="button" className="btn-secondary" disabled={busy || resendSeconds > 0 || !!expired} onClick={resend}>{resendSeconds ? `Resend code (${resendSeconds}s)` : 'Resend code'}</button><button type="button" disabled={busy} className="btn-secondary" onClick={startAgain}>{expired ? 'Start signup again' : 'Change email'}</button></div>}
    <p className="mt-6 text-sm text-center">{register ? 'Already have an account?' : 'New to ComboRoute?'} <Link className="text-coral font-bold" to={register ? '/login' : '/signup'}>{register ? 'Sign in' : 'Create an account'}</Link></p>
    <p className="text-xs text-muted mt-6">Fictional restaurants and simulated delivery. Razorpay, if configured, uses test mode only.</p>
  </div></div>;
}
