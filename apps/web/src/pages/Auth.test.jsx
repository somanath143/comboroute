import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthPage } from './Auth';
const auth = vi.hoisted(() => ({ register: vi.fn(), verifySignup: vi.fn(), resendSignup: vi.fn(), login: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => auth }));
const challenge = () => ({ challenge_id: 'pending-test-challenge', expires_at: new Date(Date.now() + 600000).toISOString(), resend_after: new Date(Date.now() + 60000).toISOString() });
beforeEach(() => {
  Object.values(auth).forEach(mock => mock.mockReset());
  auth.register.mockImplementation(async () => challenge()); auth.verifySignup.mockResolvedValue({ role: 'customer' });
  auth.resendSignup.mockImplementation(async () => challenge()); auth.login.mockResolvedValue({ role: 'customer' });
});
afterEach(cleanup);
function open(register = true) {
  return render(<MemoryRouter initialEntries={['/auth']}><Routes><Route path="/auth" element={<AuthPage register={register}/>}/><Route path="/" element={<p>Signed in successfully</p>}/></Routes></MemoryRouter>);
}
async function requestCode() {
  fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'New Customer' } });
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.test' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'customer-password-123' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send verification code' }));
  await screen.findByLabelText('Verification code');
}
describe('verified signup UI', () => {
  it('requests an email, then creates an account only after OTP verification', async () => {
    open(); await requestCode();
    expect(auth.register).toHaveBeenCalledWith('New Customer', 'new@example.test', 'customer-password-123');
    expect(auth.verifySignup).not.toHaveBeenCalled(); expect(screen.queryByText('Signed in successfully')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify email & create account' }));
    expect(await screen.findByText('Signed in successfully')).toBeVisible();
    expect(auth.verifySignup).toHaveBeenCalledWith('pending-test-challenge', '123456');
  });
  it('keeps verification open on a wrong code and allows correction', async () => {
    auth.verifySignup.mockRejectedValueOnce(new Error('Incorrect verification code.'));
    open(); await requestCode();
    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify email & create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect verification code');
    expect(screen.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '222222' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify email & create account' }));
    expect(await screen.findByText('Signed in successfully')).toBeVisible();
  });
  it('enforces resend cooldown and clears stale code after resend', async () => {
    open(); await requestCode(); expect(screen.getByRole('button', { name: /Resend code/ })).toBeDisabled();
    cleanup(); auth.register.mockResolvedValue({ ...challenge(), resend_after: new Date(0).toISOString() });
    open(); await requestCode(); fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resend code', exact: true }));
    expect(await screen.findByRole('status')).toHaveTextContent('Use the latest email');
    expect(screen.getByLabelText('Verification code')).toHaveValue(''); expect(auth.resendSignup).toHaveBeenCalledWith('pending-test-challenge');
  });
  it('shows send failures without advancing to account creation', async () => {
    auth.register.mockRejectedValue(new Error('We could not send the verification email.'));
    open();
    fireEvent.change(screen.getByLabelText('Full name'), { target: { value: 'New Customer' } }); fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'new@example.test' } }); fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'customer-password-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send verification code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not send'); expect(screen.queryByLabelText('Verification code')).not.toBeInTheDocument();
  });
  it('allows restarting expired verification and requires the password again', async () => {
    auth.register.mockResolvedValue({ ...challenge(), expires_at: new Date(0).toISOString() });
    open(); await requestCode(); expect(screen.getByRole('button', { name: 'Verify email & create account' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Start signup again' }));
    expect(screen.getByLabelText('Email')).toHaveValue('new@example.test'); expect(screen.getByLabelText('Password')).toHaveValue('');
  });
  it('keeps the existing login flow available without a signup OTP', async () => {
    open(false); fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'existing@example.test' } }); fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'existing-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in', exact: true }));
    await waitFor(() => expect(auth.login).toHaveBeenCalledWith('existing@example.test', 'existing-password'));
    expect(await screen.findByText('Signed in successfully')).toBeVisible(); expect(auth.register).not.toHaveBeenCalled();
  });
});
