import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Device, Enrollment, Session} from '@/api/types';
import {App} from '@/App';
import {checkedText, findLeak} from '../../scripts/leaks.mjs';
import {FakeBackend} from './fakeBackend';
import {makeApiKey, makeDevice, makeError, makeRequest, makeSession, makeTest} from './factories';

let fake: FakeBackend;
// Passwords made for this run.
const [NEW_PASSWORD, RIGHT_PASSWORD, WRONG_PASSWORD] = [0, 1, 2].map(() => `pw-${crypto.randomUUID()}`);
const user = userEvent.setup();

beforeEach(() => {
  // Existing walkthroughs start on Devices; the signed-in app now opens Home by default.
  window.location.hash = '#/devices';
  window.localStorage.clear();
  fake = new FakeBackend();
  fake.install();
});
afterEach(() => {
  fake.uninstall();
});

function page() {
  return render(<App />);
}

async function register() {
  page();
  await user.click(await screen.findByRole('button', {name: 'Create an account'}));
  await user.type(screen.getByLabelText('Email'), 'a@example.com');
  await user.type(screen.getByLabelText('Password'), NEW_PASSWORD);
  await user.click(screen.getByRole('button', {name: 'Create account'}));
  await screen.findByRole('link', {name: 'Devices'});
  await waitFor(() => expect(fake.openSocket).toBeDefined());
}

/** Sign up, seed two enrolled devices with a helper -> Mac test, and sit on the wizard's first step. */
function seedDevices() {
  const mac = makeDevice({kind: 'mac', name: 'studio'});
  const helper = makeDevice({kind: 'linux', name: 'gpu-box'});
  fake.devices.set(mac.id, mac);
  fake.devices.set(helper.id, helper);
  return {mac, helper};
}

async function addToken(name: string): Promise<Enrollment> {
  await user.clear(screen.getByLabelText('Device name'));
  await user.type(screen.getByLabelText('Device name'), name);
  await user.click(screen.getByRole('button', {name: 'Create token'}));
  await screen.findByText(/one-time token/i);
  return [...fake.enrollments.values()].at(-1)!;
}

async function runReachableTest(label: string) {
  const row = await screen.findByTestId(`direction-${label}`);
  await user.click(within(row).getByRole('button', {name: /test/i}));
  await waitFor(() => expect([...fake.tests.values()].at(-1)).toBeDefined());
  const test = [...fake.tests.values()].at(-1)!;
  await within(row).findByText(/Running/);
  act(() => fake.finishTest(test.id, true));
  await within(row).findByText('Reachable');
  return test;
}

async function wizardToPreflight() {
  await user.click(screen.getByRole('link', {name: 'Sessions'}));
  await user.click(await screen.findByRole('link', {name: 'New session'}));
  await user.selectOptions(await screen.findByLabelText('Service machine'), 'studio');
  await user.selectOptions(screen.getByLabelText('Helper'), 'gpu-box');
  await user.click(screen.getByRole('button', {name: 'Continue'}));
}

/** Register, enroll via the seeded devices, test helper -> Mac, then start a session and reach Ready. */
async function readySession(): Promise<{mac: Device; helper: Device; session: Session}> {
  const {mac, helper} = seedDevices();
  await register();
  await runReachableTest('gpu-box → studio');
  await wizardToPreflight();
  await user.click(await screen.findByRole('button', {name: 'Start session'}));
  await screen.findByRole('heading', {name: 'Session'});
  const session = [...fake.sessions.values()].at(-1)!;
  act(() => fake.updateSession(session.id, {state: 'ready', phase: 'serve'}));
  await screen.findByText('Ready');
  return {mac, helper, session};
}

async function submitPrompt(text: string) {
  await user.type(screen.getByLabelText('Prompt'), text);
  await user.click(screen.getByRole('button', {name: 'Send'}));
  await screen.findByTestId('output');
  return [...fake.requests.values()].at(-1)!;
}

describe('full walkthrough', () => {
  it('opens the guided home page after sign-in and links to the existing device flow', async () => {
    window.location.hash = '';
    await register();
    expect(await screen.findByRole('heading', {name: 'Home'})).toBeInTheDocument();
    expect(screen.getByText('1. Connect devices')).toBeInTheDocument();
    await user.click(screen.getAllByRole('link', {name: 'Open devices'})[0]);
    expect(await screen.findByRole('heading', {name: 'Devices'})).toBeInTheDocument();
  });

  it('fills the example prompt for a ready session', async () => {
    await readySession();
    await user.click(screen.getByRole('button', {name: 'Use example prompt'}));
    expect(screen.getByLabelText('Prompt')).toHaveValue('Show a sample request moving through OpenInfer.');
  });

  it('goes from registration to the end of a session', async () => {
    page();
    // Register.
    await user.click(await screen.findByRole('button', {name: 'Create an account'}));
    await user.type(screen.getByLabelText('Email'), 'a@example.com');
    await user.type(screen.getByLabelText('Password'), NEW_PASSWORD);
    await user.click(screen.getByRole('button', {name: 'Create account'}));
    await screen.findByRole('link', {name: 'Devices'});

    // Add the first device: the line to type in the simulator is shown, with the token in it.
    const first = await addToken('studio');
    expect(screen.getAllByTestId('enroll-command').map((n) => n.textContent)).toEqual([`enroll <device> ${first.token}`]);

    act(() => void fake.enroll(first.id, 'mac'));
    await screen.findByText('Waiting for another device');
    await user.click(screen.getByRole('button', {name: 'Add another device'}));

    // Add the second device; the waiting note goes away and both directions appear.
    const second = await addToken('gpu-box');
    act(() => void fake.enroll(second.id, 'linux'));
    await waitFor(() => expect(screen.queryByText('Waiting for another device')).not.toBeInTheDocument());

    // Test both directions; a failure can be retried.
    const macToHelperRow = await screen.findByTestId('direction-studio → gpu-box');
    await user.click(within(macToHelperRow).getByRole('button', {name: /test/i}));
    await waitFor(() => expect(fake.tests.size).toBe(1));
    act(() => fake.finishTest([...fake.tests.values()].at(-1)!.id, false));
    await within(macToHelperRow).findByText('Unreachable');
    expect(within(macToHelperRow).getByText(/Connection refused/)).toBeInTheDocument();
    expect(within(macToHelperRow).getByText(/do not use this direction/i)).toBeInTheDocument();

    await runReachableTest('gpu-box → studio');
    const plan = fake.callsTo('POST', /\/connection-tests$/).at(-1)!.body as {listener_python: string; port: number};
    expect(plan.listener_python).toBe('/opt/mlx/bin/python');
    expect(plan.port).toBe(40360);

    // Wizard: a failing check is listed with its reason, then a pass allows the start.
    fake.preflightResult = () => ({allowed: false, checks: [
      {code: 'platform', passed: true, device_id: null, message: 'Both platforms are supported.', required_bytes: null, available_bytes: null},
      {code: 'disk', passed: false, device_id: [...fake.devices.values()][1].id, message: 'Not enough disk for the helper weights.', required_bytes: '30000000000', available_bytes: '1000000000'},
    ]});
    await wizardToPreflight();
    await screen.findByText(/Not enough disk for the helper weights/);
    expect(screen.getByText(/Both platforms are supported/)).toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Start session'})).toBeDisabled();

    fake.preflightResult = null;
    await user.click(screen.getByRole('button', {name: 'Check again'}));
    await waitFor(() => expect(screen.getByRole('button', {name: 'Start session'})).toBeEnabled());
    await user.click(screen.getByRole('button', {name: 'Start session'}));

    // The session page follows server phases.
    await screen.findByRole('heading', {name: 'Session'});
    const created = fake.callsTo('POST', /\/sessions$/).at(-1)!;
    expect(created.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    const session = [...fake.sessions.values()].at(-1)!;
    // One row per device, each at its own phase; the session phase follows whichever device reported last.
    // Phases follow what the devices report (control.ts).
    const macId = session.plan.service_device_id;
    const helperId = session.plan.helpers[0].device_id;
    const step = (key: string) => screen.findByTestId(`startup-${key}`);
    act(() => fake.updateInstance(session.id, macId, {phase: 'load'}));
    act(() => fake.updateInstance(session.id, helperId, {phase: 'download'}));
    act(() => fake.updateSession(session.id, {phase: 'download'}));
    await waitFor(async () => expect(await step('service-load')).toHaveAttribute('data-status', 'current'));
    expect(await step('helper-download')).toHaveAttribute('data-status', 'current');
    act(() => fake.updateSession(session.id, {phase: 'load'}));
    expect(await step('service-load')).toHaveAttribute('data-status', 'current');
    expect(await step('helper-download')).toHaveAttribute('data-status', 'current');
    // The helper finished preparing and waits until the server is connectable.
    act(() => fake.updateInstance(session.id, helperId, {phase: 'verify'}));
    await waitFor(async () => expect(await step('helper-load')).toHaveAttribute('data-status', 'waiting'));
    expect(within(await step('helper-load')).getByText('Waiting for the server')).toBeInTheDocument();
    expect(within(await step('helper-download')).getByText('Done')).toHaveClass('sr-only');
    act(() => fake.updateInstance(session.id, macId, {phase: 'connect', state: 'connectable'}));
    act(() => fake.updateInstance(session.id, helperId, {phase: 'load', state: 'loading'}));
    await waitFor(async () => expect(await step('helper-load')).toHaveAttribute('data-status', 'current'));
    expect(await step('service-load')).toHaveAttribute('data-status', 'done');
    act(() => fake.updateInstance(session.id, helperId, {phase: 'serve', state: 'ready', push_connection_id: 'push-1'}));
    act(() => fake.updateSession(session.id, {phase: 'warmup'}));
    await waitFor(async () => expect(await step('warmup')).toHaveAttribute('data-status', 'current'));
    expect(await step('helper-load')).toHaveAttribute('data-status', 'done');
    expect(screen.getByLabelText('Prompt')).toBeDisabled();

    act(() => fake.updateSession(session.id, {state: 'ready', phase: 'serve'}));
    await screen.findByText('Ready');

    // Submit with the defaults: the request names nothing but its prompt.
    const request = await submitPrompt('Hello there');
    const posted = fake.callsTo('POST', /\/requests$/).at(-1)!;
    expect(posted.body).toEqual({prompt: 'Hello there'});
    expect(posted.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);

    // Output arrives chunk by chunk; speed starts as not available.
    expect(screen.getByTestId('speed-end-to-end')).toHaveTextContent('Not available');
    expect(screen.getByTestId('speed-decode')).toHaveTextContent('Not available');
    act(() => fake.emitChunk(request.id, 'Hello ', 4));
    await waitFor(() => expect(screen.getByTestId('output')).toHaveTextContent('Hello'));
    act(() => fake.emitChunk(request.id, 'world', 12));
    await waitFor(() => expect(screen.getByTestId('output')).toHaveTextContent('Hello world'));
    // output 16 tokens, received 0 ns, first 1.0 s, last 1.5 s, first chunk 4 tokens.
    await waitFor(() => expect(screen.getByTestId('speed-end-to-end')).toHaveTextContent('10.7 tok/s'));
    expect(screen.getByTestId('speed-decode')).toHaveTextContent('24.0 tok/s');
    expect(screen.queryByText(/complete/i)).not.toBeInTheDocument();

    act(() => fake.finishRequest(request.id));
    await screen.findByText('Output complete');

    // A new request is possible, then the session ends.
    await user.click(screen.getByRole('button', {name: 'New request'}));
    await user.click(screen.getByRole('button', {name: 'End session'}));
    await screen.findByText('Stopping');
    act(() => fake.updateSession(session.id, {state: 'ended', phase: 'kill', ended_at: new Date().toISOString()}));
    await screen.findByText('Ended');
    expect(screen.queryByRole('button', {name: 'End session'})).not.toBeInTheDocument();
  });
});

describe('identity', () => {
  it('keeps the form and shows the reason after a wrong password', async () => {
    fake.accounts.set('a@example.com', {password: RIGHT_PASSWORD, identity: {user_id: 'u', email: 'a@example.com', group_id: 'g', csrf_token: 'c', expires_at: 'x'}});
    page();
    await user.type(await screen.findByLabelText('Email'), 'a@example.com');
    await user.type(screen.getByLabelText('Password'), WRONG_PASSWORD);
    await user.click(screen.getByRole('button', {name: 'Sign in'}));
    await screen.findByText('Wrong email or password.');
    expect(screen.getByLabelText('Email')).toHaveValue('a@example.com');
    expect(screen.getByLabelText('Password')).toHaveValue(WRONG_PASSWORD);
  });

  it('shows a failed network call on the form and allows a retry', async () => {
    fake.accounts.set('a@example.com', {password: RIGHT_PASSWORD, identity: {user_id: 'u', email: 'a@example.com', group_id: 'g', csrf_token: 'c', expires_at: 'x'}});
    page();
    fake.dropNext('POST /auth/login');
    await user.type(await screen.findByLabelText('Email'), 'a@example.com');
    await user.type(screen.getByLabelText('Password'), RIGHT_PASSWORD);
    await user.click(screen.getByRole('button', {name: 'Sign in'}));
    await screen.findByText(/could not reach/i);
    await user.click(screen.getByRole('button', {name: 'Sign in'}));
    await screen.findByRole('link', {name: 'Devices'});
  });

  // With registration closed the page says so at once, instead of a form that is refused only when sent.
  it('shows that registration is closed instead of the form, and still lets an existing account sign in', async () => {
    fake.registrationClosed = true;
    fake.accounts.set('a@example.com', {password: RIGHT_PASSWORD, identity: {user_id: 'u', email: 'a@example.com', group_id: 'g', csrf_token: 'c', expires_at: 'x'}});
    page();
    await user.click(await screen.findByRole('button', {name: 'Create an account'}));
    expect(await screen.findByText('Registration is closed on this control plane. To get an account, ask the administrator of this control plane (the person who installed it).')).toBeVisible();
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByRole('button', {name: 'Create account'})).toBeNull();
    expect(fake.callsTo('POST', /^\/auth\/register$/)).toHaveLength(0);
    await user.click(screen.getByRole('button', {name: 'I already have an account'}));
    await user.type(screen.getByLabelText('Email'), 'a@example.com');
    await user.type(screen.getByLabelText('Password'), RIGHT_PASSWORD);
    await user.click(screen.getByRole('button', {name: 'Sign in'}));
    await screen.findByRole('link', {name: 'Devices'});
  });

  it('says registration is closed and whom to ask when it closes after the page was opened', async () => {
    fake.accounts.set('a@example.com', {password: RIGHT_PASSWORD, identity: {user_id: 'u', email: 'a@example.com', group_id: 'g', csrf_token: 'c', expires_at: 'x'}});
    page();
    await user.click(await screen.findByRole('button', {name: 'Create an account'}));
    fake.registrationClosed = true;
    await user.type(screen.getByLabelText('Email'), 'new@example.com');
    await user.type(screen.getByLabelText('Password'), NEW_PASSWORD);
    await user.click(screen.getByRole('button', {name: 'Create account'}));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Registration is closed on this control plane. To get an account, ask the administrator of this control plane (the person who installed it).');
    expect(screen.getByLabelText('Email')).toHaveValue('new@example.com');
    await user.click(screen.getByRole('button', {name: 'I already have an account'}));
    expect(screen.queryByRole('alert')).toBeNull();
    await user.clear(screen.getByLabelText('Email'));
    await user.type(screen.getByLabelText('Email'), 'a@example.com');
    await user.clear(screen.getByLabelText('Password'));
    await user.type(screen.getByLabelText('Password'), RIGHT_PASSWORD);
    await user.click(screen.getByRole('button', {name: 'Sign in'}));
    await screen.findByRole('link', {name: 'Devices'});
  });

  it('disables the button while signing in', async () => {
    fake.accounts.set('a@example.com', {password: RIGHT_PASSWORD, identity: {user_id: 'u', email: 'a@example.com', group_id: 'g', csrf_token: 'c', expires_at: 'x'}});
    page();
    const held = fake.hold('POST /auth/login');
    await user.type(await screen.findByLabelText('Email'), 'a@example.com');
    await user.type(screen.getByLabelText('Password'), RIGHT_PASSWORD);
    await user.click(screen.getByRole('button', {name: 'Sign in'}));
    expect(screen.getByRole('button', {name: 'Signing in'})).toBeDisabled();
    held.release();
    await screen.findByRole('link', {name: 'Devices'});
  });

  it('restores the login on load', async () => {
    fake.loggedIn = {user_id: 'u', email: 'a@example.com', group_id: 'g', csrf_token: 'c', expires_at: 'x'};
    page();
    await screen.findByRole('link', {name: 'Devices'});
  });

  it('sign out returns to the form and stops nothing on the devices', async () => {
    await register();
    await user.click(screen.getByRole('button', {name: 'Sign out'}));
    await screen.findByRole('button', {name: 'Sign in'});
    expect(fake.calls.some((c) => /stop/.test(c.path))).toBe(false);
    expect(fake.loggedIn).toBeNull();
  });

  it('a 401 from any call goes back to the form', async () => {
    await register();
    fake.failNext('POST /enrollment-tokens', 401, makeError({code: 'unauthenticated', message: 'Sign in again.'}));
    await user.type(screen.getByLabelText('Device name'), 'studio');
    await user.click(screen.getByRole('button', {name: 'Create token'}));
    await screen.findByRole('button', {name: 'Sign in'});
  });

  it('shows why signing out failed and allows another try', async () => {
    await register();
    fake.failNext('POST /auth/logout', 500, makeError({code: 'internal', message: 'Could not end the login.'}));
    await user.click(screen.getByRole('button', {name: 'Sign out'}));
    await screen.findByText('Could not end the login.');
    expect(screen.getByRole('button', {name: 'Sign out'})).toBeEnabled();
  });

  it('can sign out while the connection is down', async () => {
    await register();
    fake.withholdSnapshot = true;
    act(() => fake.dropSockets());
    await screen.findByRole('status');
    await user.click(screen.getByRole('button', {name: 'Sign out'}));
    await screen.findByRole('button', {name: 'Sign in'});
  });

  it('sends the CSRF token on writes', async () => {
    await register();
    await addToken('studio');
    expect(fake.callsTo('POST', /enrollment-tokens/)[0].headers['x-csrf-token']).toBe(fake.loggedIn!.csrf_token);
  });
});

describe('websocket', () => {
  it('is on the agreed path and subprotocol', async () => {
    await register();
    const socket = fake.sockets[0];
    expect(new URL(socket.url, 'https://x').pathname).toBe('/api/v1/ws/browser');
    expect(socket.protocol).toBe('openinfer.browser.v1');
  });

  it('shows a lost connection, keeps the request running, disables submit and recovers from a snapshot', async () => {
    const {session} = await readySession();
    const request = await submitPrompt('Hello');
    act(() => fake.emitChunk(request.id, 'one ', 4));
    await waitFor(() => expect(screen.getByTestId('output')).toHaveTextContent('one'));
    fake.requests.get(request.id)!.state = 'running';

    vi.useFakeTimers({shouldAdvanceTime: true});
    try {
      act(() => fake.dropSockets());
      await screen.findByRole('status');
      expect(screen.getByRole('status')).toHaveTextContent(/connection lost/i);
      // Nothing claims failure; the request is still shown as running.
      expect(screen.queryByText(/failed/i)).not.toBeInTheDocument();
      expect(screen.getByTestId('request-state')).toHaveTextContent('Running');

      // While away, more output is written and the socket returns.
      fake.emitChunk(request.id, 'two ', 4, true);
      fake.emitChunk(request.id, 'three', 4, true);
      await act(() => vi.advanceTimersByTimeAsync(1100));
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }

    // The backfill fills the gap and duplicates are ignored.
    await waitFor(() => expect(screen.getByTestId('output')).toHaveTextContent('one two three'));
    expect(fake.callsTo('GET', /\/chunks$/).length).toBeGreaterThan(0);
    act(() => fake.broadcast('output.chunk', fake.chunks.get(request.id)![1]));
    expect(screen.getByTestId('output').textContent).toBe('one two three');

    // The session page still works afterwards.
    expect(fake.sessions.get(session.id)!.state).toBe('ready');
  });

  it('replaces state from the new snapshot rather than merging', async () => {
    seedDevices();
    await register();
    await screen.findByText('gpu-box');
    const helper = [...fake.devices.values()][1];
    vi.useFakeTimers({shouldAdvanceTime: true});
    try {
      act(() => fake.dropSockets());
      await screen.findByRole('status');
      fake.devices.delete(helper.id);
      await act(() => vi.advanceTimersByTimeAsync(1100));
      await waitFor(() => expect(screen.queryByText('gpu-box')).not.toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers a request that finished while disconnected, by id', async () => {
    await readySession();
    const request = await submitPrompt('Hello');
    act(() => fake.emitChunk(request.id, 'partial', 4));
    await waitFor(() => expect(screen.getByTestId('output')).toHaveTextContent('partial'));

    vi.useFakeTimers({shouldAdvanceTime: true});
    try {
      act(() => fake.dropSockets());
      await screen.findByRole('status');
      fake.emitChunk(request.id, ' done', 4, true);
      Object.assign(fake.requests.get(request.id)!, {state: 'completed', final_seq: '2', archive_state: 'saved'});
      fake.sessions.get(request.session_id)!.active_request_ids = [];
      await act(() => vi.advanceTimersByTimeAsync(1100));
    } finally {
      vi.useRealTimers();
    }
    await screen.findByText('Output complete');
    expect(screen.getByTestId('output').textContent).toBe('partial done');
  });

  it('re-reads known connection tests after reconnecting, since snapshots drop finished ones', async () => {
    seedDevices();
    await register();
    const test = await runReachableTest('gpu-box → studio');
    vi.useFakeTimers({shouldAdvanceTime: true});
    try {
      act(() => fake.dropSockets());
      await screen.findByRole('status');
      await act(() => vi.advanceTimersByTimeAsync(1100));
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(fake.callsTo('GET', new RegExp(`/connection-tests/${test.id}$`)).length).toBe(1));
    const row = await screen.findByTestId('direction-gpu-box → studio');
    await within(row).findByText('Reachable');
  });

  it('retries with backoff when a socket closes before the snapshot', async () => {
    await register();
    fake.withholdSnapshot = true;
    vi.useFakeTimers({shouldAdvanceTime: true});
    try {
      act(() => fake.dropSockets());
      const count = fake.sockets.length;
      await act(() => vi.advanceTimersByTimeAsync(1100));
      expect(fake.sockets.length).toBe(count + 1);
      await act(() => vi.advanceTimersByTimeAsync(13000)); // 10 s handshake timeout, then 2 s backoff
      expect(fake.sockets.length).toBeGreaterThan(count + 1);
      fake.withholdSnapshot = false;
      fake.releaseHandshake();
      await act(() => vi.advanceTimersByTimeAsync(10));
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts the backoff over after a snapshot arrives', async () => {
    await register();
    vi.useFakeTimers({shouldAdvanceTime: true});
    try {
      act(() => fake.dropSockets());
      await act(() => vi.advanceTimersByTimeAsync(1100));
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
      const count = fake.sockets.length;
      act(() => fake.dropSockets());
      await act(() => vi.advanceTimersByTimeAsync(1100));
      expect(fake.sockets.length).toBe(count + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes to sign-in when the socket closes with 4401', async () => {
    await register();
    act(() => fake.dropSockets(4401));
    await screen.findByRole('button', {name: 'Sign in'});
  });

  it.each([[4403, /permission/i], [4400, /protocol/i]] as const)('on %i shows the reason and does not retry', async (code, text) => {
    await register();
    const me = fake.callsTo('GET', /\/auth\/me$/).length;
    vi.useFakeTimers({shouldAdvanceTime: true});
    try {
      const count = fake.sockets.length;
      act(() => fake.dropSockets(code));
      await screen.findByRole('status');
      expect(screen.getByRole('status')).toHaveTextContent(text);
      expect(screen.getByRole('status')).toHaveTextContent(/refresh the page/i);
      expect(screen.queryByRole('button', {name: 'Sign in'})).not.toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(120_000));
      expect(fake.sockets.length).toBe(count);
      expect(fake.callsTo('GET', /\/auth\/me$/).length).toBe(me);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps start and submit disabled after the server refuses the connection', async () => {
    await readySession();
    act(() => fake.dropSockets(4403));
    await screen.findByRole('status');
    expect(screen.getByRole('button', {name: 'Send'})).toBeDisabled();
  });

  it('asks /auth/me when the handshake fails, and goes to sign-in on 401', async () => {
    await register();
    vi.useFakeTimers({shouldAdvanceTime: true});
    try {
      fake.loggedIn = null; // The next upgrade is refused with HTTP 401 and no close frame.
      act(() => fake.dropSockets());
      await act(() => vi.advanceTimersByTimeAsync(1100));
      await screen.findByRole('button', {name: 'Sign in'});
    } finally {
      vi.useRealTimers();
    }
  });

  it('stays signed in and retries when the handshake fails but the login is good', async () => {
    await register();
    const before = fake.callsTo('GET', /\/auth\/me$/).length;
    vi.useFakeTimers({shouldAdvanceTime: true});
    try {
      fake.withholdSnapshot = true;
      act(() => fake.dropSockets());
      await act(() => vi.advanceTimersByTimeAsync(1100));
      act(() => fake.dropSockets()); // this attempt never upgraded
      await act(() => vi.advanceTimersByTimeAsync(10));
      expect(fake.callsTo('GET', /\/auth\/me$/).length).toBe(before + 1);
      expect(screen.getByRole('status')).toBeInTheDocument();
      expect(screen.queryByRole('button', {name: 'Sign in'})).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not ask /auth/me when an established connection drops', async () => {
    await register();
    const before = fake.callsTo('GET', /\/auth\/me$/).length;
    act(() => fake.dropSockets());
    await screen.findByRole('status');
    expect(fake.callsTo('GET', /\/auth\/me$/).length).toBe(before);
  });

  it('reconnects after resync_required without the user doing anything', async () => {
    await register();
    vi.useFakeTimers({shouldAdvanceTime: true});
    try {
      act(() => fake.broadcast('resync_required', {reason: 'buffer'}));
      await screen.findByRole('status');
      act(() => fake.dropSockets(1000));
      await act(() => vi.advanceTimersByTimeAsync(1100));
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('devices', () => {
  // The devices of this repository are simulated: a token goes to the simulator's terminal, which runs beside the server
  // and needs neither its address nor its certificate fingerprint.
  it('tells how to give the token to the simulator, and says that the devices are simulated', async () => {
    await register();
    expect(screen.getByText(/The devices here are simulated/)).toHaveTextContent(/settings of the simulator, not measurements/);
    const enrollment = await addToken('gpu-box');
    const steps = screen.getByTestId('enroll-simulator');
    expect(steps).toHaveTextContent('npm run devices');
    expect(steps).toHaveTextContent(/The simulator lists the names of its devices/);
    expect(within(steps).getByTestId('enroll-command')).toHaveTextContent(`enroll <device> ${enrollment.token}`);
    expect(document.body).not.toHaveTextContent(/certificate-sha256/);
    expect(document.body).not.toHaveTextContent(enrollment.certificate_sha256);
    expect(document.body.textContent!.split(enrollment.token!).length).toBe(2);
  });

  it('shows one device as waiting for another', async () => {
    const mac = makeDevice({kind: 'mac', name: 'studio'});
    fake.devices.set(mac.id, mac);
    await register();
    await screen.findByText('Waiting for another device');
  });

  it('can start over while waiting for a device, and says the old token stays valid', async () => {
    await register();
    await addToken('wrong-name');
    expect(screen.getByText(/stays valid until it expires/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Start over'}));
    expect(screen.getByLabelText('Device name')).toBeEnabled();
  });

  it('marks a token as failed when it expires, and allows a new one', async () => {
    await register();
    const enrollment = await addToken('studio');
    act(() => fake.expireEnrollment(enrollment.id));
    await screen.findByText(/token has expired/i);
    await user.click(screen.getByRole('button', {name: 'Request a new token'}));
    await screen.findByLabelText('Device name');
  });

  it('marks a token as enrolled when the device appears only through a snapshot', async () => {
    await register();
    const enrollment = await addToken('studio');
    vi.useFakeTimers({shouldAdvanceTime: true});
    try {
      act(() => fake.dropSockets());
      await screen.findByRole('status');
      const device = makeDevice({kind: 'mac', name: 'studio', created_at: new Date(Date.parse(enrollment.created_at) + 1000).toISOString()});
      fake.devices.set(device.id, device);
      await act(() => vi.advanceTimersByTimeAsync(1100));
    } finally {
      vi.useRealTimers();
    }
    await screen.findByRole('button', {name: 'Add another device'});
  });

  it('says to wait for the device when the port is busy', async () => {
    const {helper, mac} = seedDevices();
    await register();
    const row = await screen.findByTestId('direction-gpu-box → studio');
    act(() => fake.updateDevice(mac.id, {state: 'occupied', reservation: {session_id: 'other', role: 'service'}}));
    expect(helper.state).toBe('idle');
    await user.click(within(row).getByRole('button', {name: /test/i}));
    await within(row).findByText(/Waiting for the device to be free/);
  });

  it('names the phase, device and reason of a failed connection test', async () => {
    const {helper} = seedDevices();
    await register();
    const row = await screen.findByTestId('direction-gpu-box → studio');
    await user.click(within(row).getByRole('button', {name: /test/i}));
    await waitFor(() => expect(fake.tests.size).toBe(1));
    const test = [...fake.tests.values()].at(-1)!;
    Object.assign(test, {state: 'unreachable', error: makeError({phase: 'connect', device_id: helper.id, message: 'No route to host.'})});
    act(() => fake.broadcast('connection_test.updated', test));
    await within(row).findByText('connect · gpu-box · No route to host.');
  });

  it('shows a test state it does not know as it is, and allows another run', async () => {
    seedDevices();
    await register();
    const row = await screen.findByTestId('direction-gpu-box → studio');
    await user.click(within(row).getByRole('button', {name: /test/i}));
    await waitFor(() => expect(fake.tests.size).toBe(1));
    const test = [...fake.tests.values()].at(-1)!;
    Object.assign(test, {state: 'something_new'});
    act(() => fake.broadcast('connection_test.updated', test));
    await within(row).findByText('something_new');
    expect(within(row).queryByText('Reachable')).not.toBeInTheDocument();
    await waitFor(() => expect(within(row).getByRole('button', {name: /test/i})).toBeEnabled());
  });

  it('disables a test button while the call is waiting', async () => {
    seedDevices();
    await register();
    const row = await screen.findByTestId('direction-gpu-box → studio');
    const held = fake.hold('POST /connection-tests');
    await user.click(within(row).getByRole('button', {name: /test/i}));
    expect(within(row).getByRole('button', {name: /test/i})).toBeDisabled();
    held.release();
    await waitFor(() => expect(fake.tests.size).toBe(1));
  });

  it.each([
    ['Recheck', 'POST /devices/.*/recheck', {state: 'cleanup_required', cleanup_required: true}, false],
    ['This machine is gone. Remove it', 'POST /devices/.*/remove', {state: 'offline', cleanup_required: true}, true],
  ] as const)('disables %s while the call is waiting', async (name, route, patch, confirmFirst) => {
    const mac = makeDevice({kind: 'mac', name: 'studio', ...patch});
    fake.devices.set(mac.id, mac);
    await register();
    const card = await screen.findByTestId(`device-${mac.id}`);
    if (confirmFirst) await user.click(within(card).getByRole('button', {name: 'Remove device'}));
    const held = fake.hold(route);
    await user.click(within(card).getByRole('button', {name}));
    expect(within(card).getByRole('button', {name})).toBeDisabled();
    held.release();
    await waitFor(() => expect(fake.callsTo('POST', /(recheck|remove)$/)).toHaveLength(1));
  });

  it('offers recheck for a device awaiting cleanup', async () => {
    const mac = makeDevice({kind: 'mac', name: 'studio', state: 'cleanup_required', cleanup_required: true});
    fake.devices.set(mac.id, mac);
    await register();
    const card = await screen.findByTestId(`device-${mac.id}`);
    await user.click(within(card).getByRole('button', {name: 'Recheck'}));
    await waitFor(() => expect(fake.callsTo('POST', /recheck$/).length).toBe(1));
    expect(fake.callsTo('POST', /recheck$/)[0].body).toEqual({});
  });

  it('shows why a device is still awaiting cleanup', async () => {
    const mac = makeDevice({kind: 'mac', name: 'studio', state: 'cleanup_required', cleanup_required: true});
    mac.error = makeError({code: 'cleanup_required', phase: 'kill', device_id: mac.id, message: 'Process 12 is still running.'});
    fake.devices.set(mac.id, mac);
    await register();
    await screen.findByText('kill · studio · Process 12 is still running.');
  });

  it('clears the cleanup reason when the device reports it gone', async () => {
    const mac = makeDevice({kind: 'mac', name: 'studio', state: 'cleanup_required', cleanup_required: true,
                            error: makeError({phase: 'kill', message: 'Process 12 is still running.'})});
    fake.devices.set(mac.id, mac);
    await register();
    await screen.findByText(/Process 12 is still running/);
    act(() => fake.updateDevice(mac.id, {state: 'idle', cleanup_required: false, error: null}));
    await waitFor(() => expect(screen.queryByText(/Process 12 is still running/)).not.toBeInTheDocument());
  });

  it('removes an offline device only after confirmation', async () => {
    const mac = makeDevice({kind: 'mac', name: 'studio', state: 'offline', cleanup_required: true});
    fake.devices.set(mac.id, mac);
    await register();
    const card = await screen.findByTestId(`device-${mac.id}`);
    await user.click(within(card).getByRole('button', {name: 'Remove device'}));
    expect(fake.callsTo('POST', /remove$/).length).toBe(0);
    await user.click(within(card).getByRole('button', {name: 'This machine is gone. Remove it'}));
    await waitFor(() => expect(fake.callsTo('POST', /remove$/).length).toBe(1));
    expect(fake.callsTo('POST', /remove$/)[0].body).toEqual({confirm_unavailable: true});
    await waitFor(() => expect(screen.queryByTestId(`device-${mac.id}`)).not.toBeInTheDocument());
  });

  it('says what each device can do and keeps the raw probe in a closed Details section', async () => {
    const {mac, helper} = seedDevices();
    fake.updateDevice(helper.id, {inventory: {...helper.inventory, engines: [
      ...helper.inventory.engines,
      {name: 'sglang', version: null, available: false, build: null,
       error: makeError({code: 'engine_missing', message: 'not installed in /opt/openinfer/envs/helper/bin/python: sglang'})},
    ]}});
    await register();
    const macCard = await screen.findByTestId(`device-${mac.id}`);
    const helperCard = screen.getByTestId(`device-${helper.id}`);
    await within(macCard).findByText('Can be the server (MLX)');
    await within(helperCard).findByText('Can be a helper (llama.cpp, RTX A5000 24.0 GiB)');
    const raw = within(helperCard).getByText(/not installed in \/opt/);
    expect(raw).not.toBeVisible();
    expect(raw.closest('details')).not.toHaveAttribute('open');
    await user.click(within(helperCard).getByText('Details'));
    expect(raw).toBeVisible();
  });

  it('says a connection test is no longer valid in words, without the backend code', async () => {
    const {mac, helper} = seedDevices();
    fake.tests.set('t', makeTest({source_device_id: helper.id, target_device_id: mac.id, state: 'reachable', valid: false,
                                  invalid_reason: 'direction_unreachable', source_address: '192.0.2.20', target_address: '192.0.2.10',
                                  rtt_median_ms: 1.5, transfer_bytes: '8000000', transfer_ms: 64}));
    await register();
    const row = await screen.findByTestId('direction-gpu-box → studio');
    await within(row).findByText(/No longer valid: the address, port or device changed since the test\. Run the test again\./);
    expect(within(row).queryByText(/direction_unreachable/)).not.toBeInTheDocument();
  });

  it('shows a round trip with two decimals and bandwidth in whole Mbit/s', async () => {
    const {mac, helper} = seedDevices();
    fake.tests.set('t', makeTest({source_device_id: helper.id, target_device_id: mac.id, state: 'reachable', valid: true,
                                  source_address: '192.0.2.20', target_address: '192.0.2.10', rtt_median_ms: 0.4023140063509345,
                                  transfer_bytes: '8000000', transfer_ms: 69.3}));
    await register();
    const row = await screen.findByTestId('direction-gpu-box → studio');
    await within(row).findByText(/0\.40 ms/);
    expect(within(row).getByText(/924 Mbit\/s/)).toBeInTheDocument();
    // the link between simulated devices is simulated, and the numbers say so where they stand
    expect(within(row).getByText(/round trip 0\.40 ms · 924 Mbit\/s · simulated link$/)).toBeInTheDocument();
    expect(within(row).queryByText(/0\.4023/)).not.toBeInTheDocument();
  });

  it('shows the error when recheck is refused, and the button works again', async () => {
    const mac = makeDevice({kind: 'mac', name: 'studio', state: 'cleanup_required', cleanup_required: true});
    fake.devices.set(mac.id, mac);
    await register();
    const card = await screen.findByTestId(`device-${mac.id}`);
    fake.failNext('POST /devices/.*/recheck', 409, makeError({code: 'device_busy', message: 'Device went offline.'}));
    await user.click(within(card).getByRole('button', {name: 'Recheck'}));
    await within(card).findByText('Device went offline.');
    expect(within(card).getByRole('button', {name: 'Recheck'})).toBeEnabled();
  });
});

describe('session wizard', () => {
  it('lists only the devices a service version runs on as the service machine', async () => {
    seedDevices();
    await register();
    await user.click(screen.getByRole('link', {name: 'Sessions'}));
    await user.click(await screen.findByRole('link', {name: 'New session'}));
    const select = await screen.findByLabelText('Service machine');
    await waitFor(() => expect(within(select).getByRole('option', {name: 'studio'})).toBeInTheDocument());
    expect(within(select).queryByRole('option', {name: 'gpu-box'})).not.toBeInTheDocument();
  });

  // The service machine alone needs no helper and no connection test; the checks are of its
  // plan with no helper, for the service version that runs on it.
  it('checks the service machine alone, with no connection test', async () => {
    const {mac} = seedDevices();
    await register();
    await user.click(screen.getByRole('link', {name: 'Sessions'}));
    await user.click(await screen.findByRole('link', {name: 'New session'}));
    await user.selectOptions(await screen.findByLabelText('Service machine'), 'studio');
    await user.selectOptions(screen.getByLabelText('Helper'), 'No helper');
    await user.click(screen.getByRole('button', {name: 'Continue'}));
    await waitFor(() => expect(fake.callsTo('POST', /preflight$/)).toHaveLength(1));
    expect(fake.callsTo('POST', /preflight$/)[0].body).toEqual({service_device_id: mac.id, service_version_id: 'service-v1', helpers: []});
    expect(fake.callsTo('POST', /^\/connection-tests$/)).toHaveLength(0);
    expect(screen.queryByRole('button', {name: 'Change version'})).not.toBeInTheDocument();
  });

  it('requires a helper -> Mac test before continuing', async () => {
    seedDevices();
    await register();
    await user.click(screen.getByRole('link', {name: 'Sessions'}));
    await user.click(await screen.findByRole('link', {name: 'New session'}));
    await user.selectOptions(await screen.findByLabelText('Service machine'), 'studio');
    await user.selectOptions(screen.getByLabelText('Helper'), 'gpu-box');
    await screen.findByText(/connection test/i);
    expect(screen.getByRole('button', {name: 'Continue'})).toBeDisabled();
  });

  // After a device program restarts the test no longer counts. The page runs the two tests of the chosen devices
  // again and, once they are done, goes on to the checks with the new helper -> Mac test.
  it('runs both connection tests again from the device step and then checks', async () => {
    const {mac, helper} = seedDevices();
    await register();
    // A finished test (its listener closed) that a device restart made invalid.
    const old = makeTest({id: 'old', source_device_id: helper.id, target_device_id: mac.id, state: 'reachable', valid: false,
                          invalid_reason: 'direction_unreachable', listener_closed_at: '2026-11-14T19:00:00Z'});
    fake.tests.set(old.id, old);
    act(() => fake.broadcast('connection_test.updated', old));
    await user.click(screen.getByRole('link', {name: 'Sessions'}));
    await user.click(await screen.findByRole('link', {name: 'New session'}));
    await user.selectOptions(await screen.findByLabelText('Service machine'), 'studio');
    await user.selectOptions(screen.getByLabelText('Helper'), 'gpu-box');
    await screen.findByText(/no longer valid/);
    expect(screen.getByRole('button', {name: 'Continue'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Test both directions again'}));
    await waitFor(() => expect(fake.callsTo('POST', /^\/connection-tests$/)).toHaveLength(2));
    const plans = fake.callsTo('POST', /^\/connection-tests$/).map((c) => c.body as {source_device_id: string; target_device_id: string});
    expect(plans.map((p) => [p.source_device_id, p.target_device_id]).sort()).toEqual([[helper.id, mac.id], [mac.id, helper.id]].sort());
    expect(screen.getByRole('button', {name: 'Testing…'})).toBeDisabled();
    const started = [...fake.tests.values()].filter((t) => t.id !== 'old');
    const helperToMac = started.find((t) => t.source_device_id === helper.id)!;
    act(() => fake.finishTest(helperToMac.id, true));
    // Both have to finish first.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.callsTo('POST', /preflight$/)).toHaveLength(0);
    act(() => fake.finishTest(started.find((t) => t.source_device_id === mac.id)!.id, false));
    await waitFor(() => expect(fake.callsTo('POST', /preflight$/)).toHaveLength(1));
    const plan = fake.callsTo('POST', /preflight$/)[0].body as {helpers: {connection_test_id: string}[]};
    expect(plan.helpers[0].connection_test_id).toBe(helperToMac.id);
    await screen.findByTestId('chosen-version');
  });

  // A second click while the first POSTs are on their way would start a second round, refused for the open
  // listeners, and lose the first round's move to the checks.
  it('disables the retest button from the click, before the tests are created', async () => {
    const {mac, helper} = seedDevices();
    await register();
    const old = makeTest({id: 'old', source_device_id: helper.id, target_device_id: mac.id, state: 'reachable', valid: false,
                          invalid_reason: 'direction_unreachable', listener_closed_at: '2026-11-14T19:00:00Z'});
    fake.tests.set(old.id, old);
    act(() => fake.broadcast('connection_test.updated', old));
    await user.click(screen.getByRole('link', {name: 'Sessions'}));
    await user.click(await screen.findByRole('link', {name: 'New session'}));
    await user.selectOptions(await screen.findByLabelText('Service machine'), 'studio');
    await user.selectOptions(screen.getByLabelText('Helper'), 'gpu-box');
    const held = fake.hold('^POST /connection-tests$');
    await user.click(await screen.findByRole('button', {name: 'Test both directions again'}));
    expect(screen.getByRole('button', {name: 'Testing…'})).toBeDisabled();
    await user.click(screen.getByRole('button', {name: 'Testing…'}));
    held.release();
    await waitFor(() => expect([...fake.tests.values()].filter((t) => t.state === 'listening')).toHaveLength(2));
    expect(fake.callsTo('POST', /^\/connection-tests$/)).toHaveLength(2);
    for (const test of [...fake.tests.values()].filter((t) => t.state === 'listening')) act(() => fake.finishTest(test.id, true));
    await waitFor(() => expect(fake.callsTo('POST', /preflight$/)).toHaveLength(1));
  });

  it('runs the tests again from a failed connection check and checks again with the same version', async () => {
    const {helper} = seedDevices();
    await register();
    const first = await runReachableTest('gpu-box → studio');
    fake.preflightResult = () => ({allowed: false, checks: [{code: 'direction_unreachable', passed: false, device_id: null,
      message: 'The tested helper-to-service address is no longer valid.', required_bytes: null, available_bytes: null}]});
    await wizardToPreflight();
    expect(await screen.findByTestId('preflight-failed')).toHaveTextContent('Connection from helper to server');
    fake.preflightResult = null;
    await user.click(screen.getByRole('button', {name: 'Test both directions again'}));
    await waitFor(() => expect(fake.callsTo('POST', /^\/connection-tests$/)).toHaveLength(3));
    for (const test of [...fake.tests.values()].filter((t) => t.state === 'listening')) act(() => fake.finishTest(test.id, true));
    await waitFor(() => expect(fake.callsTo('POST', /preflight$/)).toHaveLength(2));
    const plan = fake.callsTo('POST', /preflight$/)[1].body as {helpers: {connection_test_id: string; version_id: string | null}[]};
    const renewed = [...fake.tests.values()].filter((t) => t.source_device_id === helper.id).at(-1)!;
    expect(renewed.id).not.toBe(first.id);
    expect(plan.helpers[0]).toMatchObject({connection_test_id: renewed.id, version_id: null});
    await waitFor(() => expect(screen.getByRole('button', {name: 'Start session'})).toBeEnabled());
  });

  it('checks first with the helper version Placement chose, shows it and starts that version', async () => {
    seedDevices();
    await register();
    await runReachableTest('gpu-box → studio');
    await wizardToPreflight();
    await screen.findByText(/^Chosen by OpenInfer: the most precise helper version that fits/);
    expect(screen.getByTestId('chosen-version')).toHaveTextContent('UD-Q3_K_XL + draft Q4_K_M, 5 drafts a round');
    const preflight = fake.callsTo('POST', /preflight$/).at(-1)!.body as {helpers: {version_id: string | null}[]};
    expect(preflight.helpers[0].version_id).toBeNull();
    await user.click(screen.getByRole('button', {name: 'Start session'}));
    await screen.findByRole('heading', {name: 'Session'});
    const created = fake.callsTo('POST', /\/sessions$/).at(-1)!.body as {helpers: {version_id: string | null}[]};
    expect(created.helpers[0].version_id).toBe('helper-v1');
    expect(document.body.textContent).not.toMatch(/tok\/s|speed-?up|faster/i);
  });

  it('says no helper version fits and does not start', async () => {
    const {helper} = seedDevices();
    await register();
    await runReachableTest('gpu-box → studio');
    fake.placementChoice = null;
    fake.preflightResult = () => ({allowed: false, checks: [{code: 'capacity_insufficient', passed: false, device_id: helper.id,
      message: 'No helper version fits.', required_bytes: String(16 * 2 ** 30), available_bytes: String(12 * 2 ** 30)}]});
    await wizardToPreflight();
    await screen.findByText(/^No helper version fits in the helper's free GPU memory or disk space/);
    expect(screen.queryByTestId('chosen-version')).not.toBeInTheDocument();
    const failed = screen.getByTestId('preflight-failed');
    expect(within(failed).getByText(/the smallest needs 16\.0 GiB/)).toBeInTheDocument();
    expect(failed.textContent).not.toMatch(/smaller helper version/);
    // the catalog has no version without a draft model, so that way out is not offered
    expect(screen.queryByLabelText(/without the draft model/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Start session'})).toBeDisabled();
  });

  it('can change to another helper version that fits; the ones that do not fit cannot be picked', async () => {
    const {helper} = seedDevices();
    await register();
    await runReachableTest('gpu-box → studio');
    fake.preflightResult = () => ({checks: [{code: 'capacity_insufficient', passed: true, device_id: helper.id, message: 'Fits.',
      required_bytes: String(19 * 2 ** 30), available_bytes: String(20 * 2 ** 30)}]});
    await wizardToPreflight();
    await user.click(await screen.findByRole('button', {name: 'Change version'}));
    const select = await screen.findByLabelText('Helper version');
    expect(select).toHaveValue('helper-v1');
    expect(within(select).queryByRole('option', {name: /MLX 4-bit/})).not.toBeInTheDocument();
    expect(within(select).getByRole('option', {name: /UD-Q8_K_L .*needs 33\.0 GiB.*does not fit/})).toBeDisabled();
    expect(within(select).getByRole('option', {name: /UD-Q3_K_XL .*needs 19\.0 GiB/})).toBeEnabled();
    expect(within(select).getByRole('option', {name: /UD-Q2_K_XL \+ draft.*needs 16\.0 GiB/})).toBeEnabled();
    expect(within(select).getByRole('option', {name: /UD-Q2_K_XL candidate.*draft model parameters/})).toBeInTheDocument();
    await user.selectOptions(select, 'helper-small');
    await user.click(screen.getByRole('button', {name: 'Check this version'}));
    await screen.findByRole('button', {name: 'Start session'});
    const body = fake.callsTo('POST', /preflight$/).at(-1)!.body as {helpers: {version_id: string | null}[]};
    expect(body.helpers[0].version_id).toBe('helper-small');
    expect(screen.getByTestId('chosen-version')).toHaveTextContent('UD-Q2_K_XL + draft Q4_K_M, 5 drafts a round');
  });

  it('with model folders of its own on the helper, no version is disabled for the disk and the passed disk check says why', async () => {
    const {helper} = seedDevices();
    helper.inventory = {...helper.inventory, local_model_folders: true};
    await register();
    await runReachableTest('gpu-box → studio');
    fake.preflightResult = () => ({checks: [
      {code: 'capacity_insufficient', passed: true, device_id: helper.id, message: 'Fits.', required_bytes: String(19 * 2 ** 30), available_bytes: String(40 * 2 ** 30)},
      {code: 'disk_insufficient', passed: true, device_id: helper.id, message: 'Check disk insufficient passed.', required_bytes: String(13 * 2 ** 30), available_bytes: '300'}]});
    await wizardToPreflight();
    const passed = await screen.findByText(/model files of its own.*when the session prepares/);
    expect(passed.textContent).not.toMatch(/Needs/);
    await user.click(await screen.findByRole('button', {name: 'Change version'}));
    const select = await screen.findByLabelText('Helper version');
    for (const name of [/UD-Q8_K_L /, /UD-Q3_K_XL /, /UD-Q2_K_XL \+ draft/]) {
      expect(within(select).getByRole('option', {name})).toBeEnabled();
      expect(within(select).getByRole('option', {name}).textContent).not.toMatch(/does not fit/);
    }
  });

  it('marks a service machine without an M2 Pro as unverified and still allows starting', async () => {
    const {mac} = seedDevices();
    await register();
    await runReachableTest('gpu-box → studio');
    fake.preflightResult = () => ({checks: [{code: 'hardware_unverified', passed: true, device_id: mac.id,
      message: 'Apple M3 Pro has not been verified as a serving machine (the verified chip is the Apple M2 Pro); it may serve.', required_bytes: null, available_bytes: null}]});
    await wizardToPreflight();
    const notice = await screen.findByTestId('preflight-notices');
    expect(within(notice).getByText('Unverified')).toBeInTheDocument();
    expect(within(notice).getByText(/Apple M3 Pro has not been verified/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', {name: 'Start session'})).toBeEnabled());
  });

  it('returns to device selection if a device goes offline', async () => {
    const {helper} = seedDevices();
    await register();
    await runReachableTest('gpu-box → studio');
    await wizardToPreflight();
    await screen.findByRole('button', {name: 'Start session'});
    act(() => fake.updateDevice(helper.id, {state: 'offline'}));
    await screen.findByText(/gpu-box went offline/);
    expect(screen.getByRole('button', {name: 'Continue'})).toBeInTheDocument();
  });

  it('disables start while the connection is down', async () => {
    seedDevices();
    await register();
    await runReachableTest('gpu-box → studio');
    await wizardToPreflight();
    await waitFor(() => expect(screen.getByRole('button', {name: 'Start session'})).toBeEnabled());
    vi.useFakeTimers({shouldAdvanceTime: true});
    try {
      fake.withholdSnapshot = true;
      act(() => fake.dropSockets());
      await screen.findByRole('status');
      expect(screen.getByRole('button', {name: 'Start session'})).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('after a timeout retries with the same key and does not create a second session', async () => {
    seedDevices();
    await register();
    await runReachableTest('gpu-box → studio');
    await wizardToPreflight();
    fake.dropNext('POST /sessions$');
    await user.click(await screen.findByRole('button', {name: 'Start session'}));
    await user.click(await screen.findByRole('button', {name: 'Try again'}));
    await screen.findByRole('heading', {name: 'Session'});
    const posts = fake.callsTo('POST', /\/sessions$/);
    expect(posts).toHaveLength(2);
    expect(posts[0].headers['idempotency-key']).toBe(posts[1].headers['idempotency-key']);
    expect(fake.sessions.size).toBe(1);
  });

  it('disables Try again while the connection is down, and enables it after a snapshot', async () => {
    seedDevices();
    await register();
    await runReachableTest('gpu-box → studio');
    await wizardToPreflight();
    fake.dropNext('POST /sessions$');
    await user.click(await screen.findByRole('button', {name: 'Start session'}));
    const retry = await screen.findByRole('button', {name: 'Try again'});
    expect(retry).toBeEnabled();
    vi.useFakeTimers({shouldAdvanceTime: true});
    try {
      act(() => fake.dropSockets());
      await screen.findByRole('status');
      expect(screen.getByRole('button', {name: 'Try again'})).toBeDisabled();
      expect(screen.getByText(/starting is paused/i)).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(1100));
      await waitFor(() => expect(screen.getByRole('button', {name: 'Try again'})).toBeEnabled());
    } finally {
      vi.useRealTimers();
    }
  });

  it('a rejected start returns to the device step with the reason', async () => {
    seedDevices();
    await register();
    await runReachableTest('gpu-box → studio');
    await wizardToPreflight();
    fake.failNext('POST /sessions$', 409, makeError({code: 'device_busy', message: 'gpu-box is already in use.'}));
    await user.click(await screen.findByRole('button', {name: 'Start session'}));
    await screen.findByText('gpu-box is already in use.');
    expect(screen.getByRole('button', {name: 'Continue'})).toBeInTheDocument();
  });

  it('offers running without the draft model only for a capacity failure, then resends the plan', async () => {
    const {helper} = seedDevices();
    // the choice exists only when the catalog has a version without a draft model
    fake.catalog.versions.push({...fake.catalog.versions.find((v) => v.id === 'helper-v1')!, id: 'helper-plain', label: 'Without a draft model',
                                draft_model: {enabled: false}});
    await register();
    await runReachableTest('gpu-box → studio');
    fake.preflightResult = (plan) => plan.helpers[0].draft_model === 'enabled'
      ? {allowed: false, checks: [{code: 'capacity_insufficient', passed: false, device_id: helper.id, message: 'The draft model does not fit.', required_bytes: null, available_bytes: null}]}
      : {};
    await wizardToPreflight();
    await user.click(await screen.findByLabelText(/without the draft model/i));
    await waitFor(() => expect(screen.getByRole('button', {name: 'Start session'})).toBeEnabled());
    const body = fake.callsTo('POST', /preflight$/).at(-1)!.body as {helpers: {draft_model: string; acknowledge_no_draft_model: boolean}[]};
    expect(body.helpers[0]).toMatchObject({draft_model: 'disabled', acknowledge_no_draft_model: true});
  });

  it('does not offer the no-draft-model choice when the service machine lacks memory', async () => {
    // The choice is for the helper's draft model; the Mac's capacity failure has no such remedy.
    const {mac} = seedDevices();
    await register();
    await runReachableTest('gpu-box → studio');
    fake.preflightResult = () => ({allowed: false, checks: [{code: 'capacity_insufficient', passed: false, device_id: mac.id, message: 'Requires more memory.', required_bytes: '2', available_bytes: '1'}]});
    await wizardToPreflight();
    await within(await screen.findByTestId('preflight-failed')).findByText('Memory');
    expect(screen.queryByLabelText(/without the draft model/i)).not.toBeInTheDocument();
  });

  it('does not offer the no-draft-model choice for other failures', async () => {
    seedDevices();
    await register();
    await runReachableTest('gpu-box → studio');
    fake.preflightResult = () => ({allowed: false, checks: [{code: 'disk', passed: false, device_id: null, message: 'No disk.', required_bytes: null, available_bytes: null}]});
    await wizardToPreflight();
    await screen.findByText(/No disk/);
    expect(screen.queryByLabelText(/without the draft model/i)).not.toBeInTheDocument();
  });

  it('counts the passed checks, lists failures first by name, and folds the passed ones', async () => {
    const {helper} = seedDevices();
    await register();
    await runReachableTest('gpu-box → studio');
    fake.preflightResult = () => ({allowed: false, checks: [
      {code: 'distinct_devices', passed: true, device_id: null, message: 'Check distinct devices passed.', required_bytes: null, available_bytes: null},
      {code: 'version_setup_missing', passed: true, device_id: helper.id, message: 'Check version setup missing passed.', required_bytes: null, available_bytes: null},
      {code: 'version_compatibility', passed: true, device_id: null, message: 'Check version compatibility passed.', required_bytes: null, available_bytes: null},
      {code: 'disk_insufficient', passed: false, device_id: helper.id, message: 'Requires 30000000000 bytes; device currently has 1000000000 bytes available.',
       required_bytes: '30000000000', available_bytes: '1000000000'},
    ]});
    await wizardToPreflight();
    await screen.findByText('3 of 4 checks passed');
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3');
    const failed = screen.getByTestId('preflight-failed');
    expect(within(failed).getByText('Disk')).toBeInTheDocument();
    expect(within(failed).getByText('Needs 27.9 GiB, 0.9 GiB available')).toBeInTheDocument();
    expect(within(failed).getByText(/free disk space/i)).toBeInTheDocument();
    const passed = screen.getByText('Model version');
    expect(passed).not.toBeVisible();
    expect(document.body.textContent).not.toMatch(/setup missing|passed\./i);
  });

  it('shows a failed preflight call and can try again', async () => {
    seedDevices();
    await register();
    await runReachableTest('gpu-box → studio');
    fake.failNext('POST /sessions/preflight', 500, makeError({code: 'internal', message: 'Database unavailable.'}));
    await wizardToPreflight();
    await screen.findByText('Database unavailable.');
    await user.click(screen.getByRole('button', {name: 'Check again'}));
    await screen.findByRole('button', {name: 'Start session'});
  });

  it('shows the device and reason when a preflight reference no longer exists', async () => {
    const {helper} = seedDevices();
    await register();
    await runReachableTest('gpu-box → studio');
    fake.failNext('POST /sessions/preflight', 404, makeError({code: 'not_found', device_id: helper.id, message: 'That device no longer exists.'}));
    await wizardToPreflight();
    await screen.findByText('gpu-box · That device no longer exists.');
    expect(screen.getByRole('button', {name: 'Start session'})).toBeDisabled();
  });

  it('shows a failed catalog read and can try again', async () => {
    seedDevices();
    await register();
    await runReachableTest('gpu-box → studio');
    fake.failNext('GET /catalog', 500, makeError({code: 'internal', message: 'Catalog unavailable.'}));
    await user.click(screen.getByRole('link', {name: 'Sessions'}));
    await user.click(await screen.findByRole('link', {name: 'New session'}));
    await screen.findByText('Catalog unavailable.');
    await user.click(screen.getByRole('button', {name: 'Try again'}));
    await waitFor(() => expect(screen.queryByText('Catalog unavailable.')).not.toBeInTheDocument());
  });
});

describe('session page', () => {
  // The first start downloads 18.7 GB on the helper; the page says how far it is and, once it can tell, how fast.
  it('shows how much of the model is downloaded and, after a second report, the speed and the time left', async () => {
    seedDevices();
    await register();
    await runReachableTest('gpu-box → studio');
    await wizardToPreflight();
    await user.click(await screen.findByRole('button', {name: 'Start session'}));
    await screen.findByRole('heading', {name: 'Session'});
    const session = [...fake.sessions.values()].at(-1)!;
    const helperId = session.plan.helpers[0].device_id;
    const report = (done: number, at: string) => fake.updateInstance(session.id, helperId, {phase: 'download',
      progress: {completed_bytes: String(done), total_bytes: '18702184960', at}});
    act(() => report(1_000_000_000, '2026-11-14T19:06:00Z'));
    const bar = await screen.findByRole('progressbar', {name: '1.0 of 18.7 GB · 5%'});
    // the download is the simulator's, and the card that shows its rate says so
    expect(screen.getByText(/^Each device gets ready on its own\./)).toHaveTextContent("The downloads are simulated: their sizes and rates are the simulator's settings, not measurements.");
    expect(bar).toHaveAttribute('aria-valuenow', '1000000000');
    expect(bar).toHaveAttribute('aria-valuemax', '18702184960');
    act(() => report(1_143_000_000, '2026-11-14T19:06:10Z'));
    await screen.findByRole('progressbar', {name: '1.1 of 18.7 GB · 6% · 14.3 MB/s · about 20 min left'});
    act(() => fake.updateInstance(session.id, helperId, {phase: 'verify', progress: null}));
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
  });

  it('reconnects a helper after it drops, and a failed reconnect stays degraded', async () => {
    const {session} = await readySession();
    act(() => fake.updateSession(session.id, {state: 'degraded'}));
    await screen.findByText('Degraded');

    fake.failNext('POST /sessions/.*/reconnect', 409, makeError({code: 'session_not_ready', message: 'The old helper has not stopped yet.'}));
    await user.click(screen.getByRole('button', {name: 'Reconnect helper'}));
    await screen.findByText('The old helper has not stopped yet.');
    expect(screen.getByText('Degraded')).toBeInTheDocument();

    await user.click(screen.getByRole('button', {name: 'Reconnect helper'}));
    await waitFor(() => expect(fake.callsTo('POST', /reconnect$/).length).toBe(2));
    // The click alone changes nothing on the page; the server decides.
    expect(screen.getByText('Degraded')).toBeInTheDocument();
    act(() => fake.updateSession(session.id, {state: 'ready'}));
    await screen.findByText('Ready');
    expect(screen.queryByRole('button', {name: 'Reconnect helper'})).not.toBeInTheDocument();
  });

  it('names the phase and device when a session action is refused', async () => {
    const {helper} = await readySession();
    fake.failNext('POST /sessions/.*/stop', 409, makeError({code: 'x', phase: 'drain', device_id: helper.id, message: 'Still draining.'}));
    await user.click(screen.getByRole('button', {name: 'End session'}));
    await screen.findByText('drain · gpu-box · Still draining.');
  });

  it('disables Reconnect helper while the call is waiting', async () => {
    const {session} = await readySession();
    act(() => fake.updateSession(session.id, {state: 'degraded'}));
    await screen.findByText('Degraded');
    const held = fake.hold('POST /sessions/.*/reconnect');
    await user.click(screen.getByRole('button', {name: 'Reconnect helper'}));
    expect(screen.getByRole('button', {name: 'Reconnect helper'})).toBeDisabled();
    held.release();
    await waitFor(() => expect(fake.callsTo('POST', /reconnect$/)).toHaveLength(1));
  });

  it('can submit while degraded', async () => {
    const {session} = await readySession();
    act(() => fake.updateSession(session.id, {state: 'degraded'}));
    await screen.findByText('Degraded');
    expect(screen.getByRole('button', {name: 'Send'})).toBeEnabled();
  });

  it('shows the actual phase while stopping', async () => {
    const {session} = await readySession();
    for (const [phase, text] of [['drain', /running request/i], ['term', /asking/i], ['kill', /forcing/i]] as const) {
      act(() => fake.updateSession(session.id, {state: 'stopping', phase, stop_deadline_at: '2026-11-08T12:01:00Z'}));
      await screen.findByText(text);
    }
  });

  it('keeps showing degraded after a reconnect is accepted, until the server says otherwise', async () => {
    const {session, helper} = await readySession();
    act(() => fake.updateSession(session.id, {state: 'degraded'}));
    await screen.findByText('Degraded');
    act(() => fake.updateDevice(helper.id, {state: 'offline'}));
    await waitFor(() => expect(screen.queryByRole('button', {name: 'Reconnect helper'})).not.toBeInTheDocument());
    act(() => fake.updateDevice(helper.id, {state: 'occupied'}));
    await user.click(await screen.findByRole('button', {name: 'Reconnect helper'}));
    await waitFor(() => expect(fake.callsTo('POST', /reconnect$/).length).toBe(1));
    expect(screen.getByText('Degraded')).toBeInTheDocument();
  });

  it('shows the phase, device and reason of a failed session', async () => {
    const {session, helper} = await readySession();
    act(() => fake.updateSession(session.id, {state: 'failed', phase: 'load', error: makeError({phase: 'load', device_id: helper.id, message: 'Out of memory.'})}));
    await screen.findByText('load · gpu-box · Out of memory.');
  });

  it('points to the devices page when a device was not cleared', async () => {
    const {session, helper} = await readySession();
    act(() => fake.updateSession(session.id, {state: 'ended', uncleared_device_ids: [helper.id]}));
    await screen.findByText(/gpu-box.*not confirmed/i);
    expect(screen.getByRole('link', {name: /devices page/i})).toBeInTheDocument();
  });

  it('disables End session while the call waits; pressing it does not claim success', async () => {
    const {session} = await readySession();
    const held = fake.hold('POST /sessions/.*/stop');
    await user.click(screen.getByRole('button', {name: 'End session'}));
    expect(screen.getByRole('button', {name: 'End session'})).toBeDisabled();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    held.release();
    await screen.findByText('Stopping');
    expect(fake.sessions.get(session.id)!.state).toBe('stopping');
  });

  it('warns about a helper whose control connection dropped while the session stays ready', async () => {
    const {helper} = await readySession();
    act(() => fake.updateDevice(helper.id, {state: 'offline'}));
    await screen.findByText(/gpu-box lost its control connection/);
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('opens a session that is not in the snapshot by id', async () => {
    await register();
    const old = makeSession({state: 'ended', phase: 'kill'});
    fake.sessions.set(old.id, old);
    window.location.hash = `#/sessions/${old.id}`;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await screen.findByText('Ended');
  });

  it('shows a missing session plainly', async () => {
    await register();
    window.location.hash = '#/sessions/00000000-0000-4000-8000-ffffffffffff';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await screen.findByText(/not found/i);
  });

  it('shows the helper as connected while ready and as degraded while degraded', async () => {
    const {session} = await readySession();
    await screen.findByText('Helper connected');
    act(() => fake.updateSession(session.id, {state: 'degraded'}));
    await screen.findByText('Helper degraded');
    expect(screen.queryByText('Helper connected')).not.toBeInTheDocument();
  });

  it('names the devices and the helper version the session runs', async () => {
    await readySession();
    await screen.findByText(/studio with gpu-box/);
    expect(screen.getByText(/UD-Q3_K_XL \+ draft Q4_K_M, 5 drafts a round/)).toBeInTheDocument();
  });

  it('lists sessions on the sessions page', async () => {
    await readySession();
    await user.click(screen.getByRole('link', {name: 'Sessions'}));
    await screen.findByRole('link', {name: /Ready/});
  });
});

describe('requests', () => {
  it('sends a maximum output when given', async () => {
    await readySession();
    await user.type(screen.getByLabelText('Maximum output (tokens)'), '128');
    await submitPrompt('Hi');
    expect(fake.callsTo('POST', /\/requests$/).at(-1)!.body).toEqual({prompt: 'Hi', max_output_tokens: 128});
  });

  it('takes the prompt from an uploaded file, sends its id, and links the file and the saved result for download', async () => {
    await readySession();
    // the server keeps its files in a bucket, and the control says so before anything is uploaded
    expect(screen.getByTestId('prompt-file-note')).toHaveTextContent('Instead of typing: a .txt or .md file of up to 64 KiB. It is uploaded and kept in the storage bucket.');
    await user.upload(screen.getByLabelText('Prompt from a file'), new File(['Explain this.\n'], 'task.md', {type: 'text/markdown'}));
    const chosen = await screen.findByTestId('prompt-file');
    expect(screen.getByTestId('prompt-file-note')).toHaveTextContent('The request reads its prompt from this file and keeps a link to it. The file is kept in the storage bucket.');
    // uploaded as the file's own bytes, with its name in the query
    const sent = fake.callsTo('POST', /^\/files$/);
    expect(sent.map((c) => [c.query, c.headers['content-type'], c.body])).toEqual([['?name=task.md', 'text/markdown', 'Explain this.\n']]);
    const stored = [...fake.files.values()][0];
    expect(chosen).toHaveTextContent('task.md · 14 bytes');
    expect(within(chosen).getByRole('link', {name: 'task.md'})).toHaveAttribute('href', `/api/v1/files/${stored.id}/content`);
    expect(screen.queryByLabelText('Prompt')).toBeNull();   // the file is the prompt
    await user.click(screen.getByRole('button', {name: 'Send'}));
    await screen.findByTestId('output');
    expect(fake.callsTo('POST', /\/requests$/).map((c) => c.body)).toEqual([{prompt_file_id: stored.id}]);
    const request = [...fake.requests.values()].at(-1)!;
    // the running request names its file; once its result is saved, the result downloads too
    const kept = await screen.findByTestId('request-files');
    expect(within(kept).getByRole('link', {name: 'task.md'})).toHaveAttribute('href', `/api/v1/files/${stored.id}/content`);
    expect(within(kept).queryByRole('link', {name: 'Download result'})).toBeNull();
    act(() => fake.emitChunk(request.id, 'Done.', 2));
    act(() => fake.finishRequest(request.id));
    expect(await within(kept).findByRole('link', {name: 'Download result'})).toHaveAttribute('href', `/api/v1/requests/${request.id}/result?download=1`);
    expect(kept).toHaveTextContent('Downloads are kept in the storage bucket.');
    // a click fetches the file and hands it to the browser to save under its name
    const saved: {blob: Blob; name: string}[] = [];
    Object.assign(URL, {createObjectURL: (blob: Blob) => { saved.push({blob, name: ''}); return 'blob:saved'; }, revokeObjectURL: () => {}});
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { saved.at(-1)!.name = this.download; });
    try {
      await user.click(within(kept).getByRole('link', {name: 'task.md'}));
      await waitFor(() => expect(saved).toHaveLength(1));
      expect([saved[0].name, await saved[0].blob.text()]).toEqual(['task.md', 'Explain this.\n']);
      await user.click(within(kept).getByRole('link', {name: 'Download result'}));
      await waitFor(() => expect(saved).toHaveLength(2));
      expect(saved[1].name).toBe(`request-${request.id}.json`);
      expect(JSON.parse(await saved[1].blob.text()).request_id).toBe(request.id);
    } finally { click.mockRestore(); }
    // the list of recent requests gives the same downloads for a request opened there
    const history = screen.getByTestId('request-history');
    await user.click(await within(history).findByRole('button', {expanded: false}));
    const again = await within(history).findByTestId('request-files');
    expect(within(again).getByRole('link', {name: 'task.md'})).toBeInTheDocument();
    expect(within(again).getByRole('link', {name: 'Download result'})).toBeInTheDocument();
  });

  it('without a bucket says that files are kept in memory until the server restarts, and shows why a download no longer works', async () => {
    fake.storage = 'memory';
    await readySession();
    const memory = 'kept only in the memory of the server process, because no storage bucket is configured, and lost when the server restarts.';
    expect(screen.getByTestId('prompt-file-note')).toHaveTextContent(`It is uploaded and ${memory}`);
    await user.upload(screen.getByLabelText('Prompt from a file'), new File(['Explain this.\n'], 'task.md', {type: 'text/markdown'}));
    await screen.findByTestId('prompt-file');
    expect(screen.getByTestId('prompt-file-note')).toHaveTextContent(`The file is ${memory}`);
    await user.click(screen.getByRole('button', {name: 'Send'}));
    await screen.findByTestId('output');
    const request = [...fake.requests.values()].at(-1)!;
    act(() => fake.emitChunk(request.id, 'Done.', 2));
    act(() => fake.finishRequest(request.id));
    const kept = await screen.findByTestId('request-files');
    await within(kept).findByRole('link', {name: 'Download result'});
    expect(kept).toHaveTextContent(`Downloads are ${memory}`);
    expect(kept).not.toHaveTextContent('kept in the storage bucket');
    // after a restart the server no longer has the objects: the page shows what the server answers
    const gone = (what: string) => makeError({code: 'not_stored', message: `This ${what} is no longer stored. No bucket is configured, so it was kept in the memory of the server process and was lost when the server restarted.`});
    fake.failNext('GET /files/.*/content', 410, gone('file'));
    await user.click(within(kept).getByRole('link', {name: 'task.md'}));
    await within(kept).findByText(/This file is no longer stored\. No bucket is configured/);
    fake.failNext('GET /requests/.*/result', 410, gone('result'));
    await user.click(within(kept).getByRole('link', {name: 'Download result'}));
    await within(kept).findByText(/This result is no longer stored\./);
  });

  it('a typed request has no file to download, and no result to download when the result was not saved', async () => {
    await readySession();
    const request = await submitPrompt('Hello');
    act(() => fake.emitChunk(request.id, 'Hello world', 16));
    act(() => fake.finishRequest(request.id, {archive_state: 'failed'}));
    await screen.findByText('Output complete');
    expect(screen.queryByTestId('request-files')).toBeNull();
  });

  it('refuses a file that is not .txt or .md, or is too large, without uploading it; the file can be removed again', async () => {
    await readySession();
    const choose = (file: File) => fireEvent.change(screen.getByLabelText('Prompt from a file'), {target: {files: [file]}});
    choose(new File(['%PDF'], 'slides.pdf', {type: 'application/pdf'}));
    await screen.findByText('Choose a .txt or .md file.');
    choose(new File(['a'.repeat(64 * 1024 + 1)], 'big.txt', {type: 'text/plain'}));
    await screen.findByText('The file is over the 64 KiB limit.');
    expect(fake.callsTo('POST', /^\/files$/)).toHaveLength(0);
    choose(new File(['fine'], 'fine.txt', {type: 'text/plain'}));
    await screen.findByTestId('prompt-file');
    expect(screen.queryByText('The file is over the 64 KiB limit.')).toBeNull();
    await user.click(screen.getByRole('button', {name: 'Remove file'}));
    expect(screen.getByLabelText('Prompt')).toBeInTheDocument();
    expect(screen.queryByTestId('prompt-file')).toBeNull();
  });

  it('says why an upload failed and keeps the prompt box', async () => {
    await readySession();
    fake.failNext('POST /files', 502, makeError({code: 'file_store_failed', message: 'The file could not be saved to the storage bucket; try again.', retryable: true}));
    await user.upload(screen.getByLabelText('Prompt from a file'), new File(['x'], 'task.txt', {type: 'text/plain'}));
    await screen.findByText(/could not be saved to the storage bucket/);
    expect(screen.getByLabelText('Prompt')).toBeInTheDocument();
  });

  it('shows an input problem without calling the server', async () => {
    await readySession();
    await user.click(screen.getByRole('button', {name: 'Send'}));
    await screen.findByText('Enter a prompt.');
    expect(fake.callsTo('POST', /\/requests$/)).toHaveLength(0);
  });

  it('returns to editing with the draft on 409 busy', async () => {
    await readySession();
    fake.failNext('POST /sessions/.*/requests', 409, makeError({code: 'request_busy', message: 'A request is already running.'}));
    await user.type(screen.getByLabelText('Prompt'), 'Hello');
    await user.click(screen.getByRole('button', {name: 'Send'}));
    await screen.findByText('A request is already running.');
    expect(screen.getByLabelText('Prompt')).toHaveValue('Hello');
  });

  it('after a timeout retries with the same key, and only one request exists', async () => {
    await readySession();
    fake.dropNext('POST /sessions/.*/requests');
    await user.type(screen.getByLabelText('Prompt'), 'Hello');
    await user.click(screen.getByRole('button', {name: 'Send'}));
    await user.click(await screen.findByRole('button', {name: 'Try again'}));
    await screen.findByTestId('output');
    const posts = fake.callsTo('POST', /\/requests$/);
    expect(posts).toHaveLength(2);
    expect(posts[0].headers['idempotency-key']).toBe(posts[1].headers['idempotency-key']);
    expect(fake.requests.size).toBe(1);
  });

  it('disables Try again for a request while the connection is down, and enables it after a snapshot', async () => {
    await readySession();
    fake.dropNext('POST /sessions/.*/requests');
    await user.type(screen.getByLabelText('Prompt'), 'Hello');
    await user.click(screen.getByRole('button', {name: 'Send'}));
    await screen.findByRole('button', {name: 'Try again'});
    vi.useFakeTimers({shouldAdvanceTime: true});
    try {
      act(() => fake.dropSockets());
      await screen.findByRole('status');
      expect(screen.getByRole('button', {name: 'Try again'})).toBeDisabled();
      expect(screen.getByText(/new requests are paused/i)).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(1100));
      await waitFor(() => expect(screen.getByRole('button', {name: 'Try again'})).toBeEnabled());
    } finally {
      vi.useRealTimers();
    }
  });

  it('after a timeout can go back to editing', async () => {
    await readySession();
    fake.dropNext('POST /sessions/.*/requests');
    await user.type(screen.getByLabelText('Prompt'), 'Hello');
    await user.click(screen.getByRole('button', {name: 'Send'}));
    await user.click(await screen.findByRole('button', {name: 'Back to editing'}));
    expect(screen.getByLabelText('Prompt')).toHaveValue('Hello');
  });

  it('disables Send while the call waits', async () => {
    await readySession();
    const held = fake.hold('POST /sessions/.*/requests');
    await user.type(screen.getByLabelText('Prompt'), 'Hello');
    await user.click(screen.getByRole('button', {name: 'Send'}));
    expect(screen.getByRole('button', {name: /Sending/})).toBeDisabled();
    held.release();
    await screen.findByTestId('output');
  });

  it('has no control to cancel a single request', async () => {
    await readySession();
    await submitPrompt('Hello');
    expect(screen.queryByRole('button', {name: /cancel/i})).not.toBeInTheDocument();
  });

  it('shows no predicted speed or speedup', async () => {
    await readySession();
    await submitPrompt('Hello');
    expect(document.body.textContent).not.toMatch(/expected speed|estimated speed|speedup|speed-up|\d×/i);
  });

  it('shows model output as plain text, never as HTML', async () => {
    await readySession();
    const request = await submitPrompt('Hello');
    act(() => fake.emitChunk(request.id, '<img src=x onerror=alert(1)><b>bold</b>', 4));
    const output = await screen.findByTestId('output');
    await waitFor(() => expect(output).toHaveTextContent('<b>bold</b>'));
    expect(output.querySelector('img,b')).toBeNull();
  });

  it('shows fenced code in a monospace block and the rest as text', async () => {
    await readySession();
    const request = await submitPrompt('Write code');
    act(() => fake.emitChunk(request.id, 'Here it is:\n```python\ndef f():\n    return 1\n```\nThat is all.', 20));
    const output = await screen.findByTestId('output');
    const code = await within(output).findByText(/def f\(\):/);
    expect(code.closest('pre')).not.toBeNull();
    expect(code.textContent).toBe('def f():\n    return 1');
    expect(within(output).getByText('python')).toBeInTheDocument();
    expect(within(output).getByText('Here it is:').closest('pre')).toBeNull();
    expect(within(output).getByText('That is all.').closest('pre')).toBeNull();
    expect(output).not.toHaveTextContent('```');
  });

  it('after the request ends says how many tokens the server took from the helper', async () => {
    await readySession();
    const request = await submitPrompt('Hello');
    act(() => fake.emitChunk(request.id, 'Hello world', 16));
    expect(screen.queryByText(/written by the helper/)).not.toBeInTheDocument();
    act(() => fake.finishRequest(request.id, {statistics: {...request.statistics, accepted_external_tokens: '12'}}));
    await screen.findByText('The server used 12 tokens written by the helper (of 16, 75%).');
    // the numbers of a simulated device are never shown as measurements
    expect(screen.getByTestId('simulated-note')).toHaveTextContent("The devices are simulated: these speeds are computed from the simulator's output, whose pace and helper's share are settings, not measurements.");
  });

  it('leaves the helper share out when the count is unknown', async () => {
    await readySession();
    const request = await submitPrompt('Hello');
    act(() => fake.emitChunk(request.id, 'Hello world', 16));
    act(() => fake.finishRequest(request.id));
    await screen.findByText('Output complete');
    expect(screen.queryByText(/written by the helper/)).not.toBeInTheDocument();
  });

  it('shows why a failed request ended, and offers a new one', async () => {
    const {session} = await readySession();
    const request = await submitPrompt('Hello');
    act(() => fake.emitChunk(request.id, 'part', 4));
    await waitFor(() => expect(screen.getByTestId('output')).toHaveTextContent('part'));
    act(() => fake.finishRequest(request.id, {state: 'failed', final_seq: null, archive_state: 'saved', error: makeError({phase: 'serve', message: 'The engine stopped.'})}));
    await screen.findByText('serve · The engine stopped.');
    expect(fake.sessions.get(session.id)!.state).toBe('ready');
    await user.click(screen.getByRole('button', {name: 'New request'}));
    expect(screen.getByLabelText('Prompt')).toBeEnabled();
  });

  it('shows the serving machine\'s reason when it refuses a maximum output, and the session stays usable', async () => {
    // a maximum output above 4096 - (the room kept for the helper) - prompt tokens passes the control plane, which cannot
    // know the prompt length, and is refused by the serving machine: the request fails with the machine's own words
    const {session} = await readySession();
    await user.type(screen.getByLabelText('Maximum output (tokens)'), '4000');
    const request = await submitPrompt('Hello');
    expect(request.requested_max_output).toBe(4000);
    const reason = 'prompt has 72 tokens; output must fit remaining 3954 of 4096 (70 kept for the helper)';
    act(() => fake.finishRequest(request.id, {state: 'failed', final_seq: null, archive_state: 'saved', error: makeError({code: 'context_budget_exceeded', message: reason})}));
    await screen.findByText(reason);
    expect(fake.sessions.get(session.id)!.state).toBe('ready');
    await user.click(screen.getByRole('button', {name: 'New request'}));
    expect(screen.getByLabelText('Prompt')).toBeEnabled();
  });

  it('shows when the result could not be archived', async () => {
    await readySession();
    const request = await submitPrompt('Hello');
    act(() => fake.emitChunk(request.id, 'text', 4));
    await waitFor(() => expect(screen.getByTestId('output')).toHaveTextContent('text'));
    act(() => fake.finishRequest(request.id, {state: 'failed', archive_state: 'failed', error: makeError({code: 'archive_failed', message: 'Could not save the result.'}), archive_error: makeError({code: 'archive_failed', message: 'Could not save the result.'})}));
    await screen.findAllByText(/Could not save the result/);
  });

  it('after a page reload restores the running output by request id', async () => {
    const {session} = await readySession();
    const request = await submitPrompt('Hello');
    act(() => fake.emitChunk(request.id, 'before', 4));
    await waitFor(() => expect(screen.getByTestId('output')).toHaveTextContent('before'));
    const hash = window.location.hash;
    expect(hash).toContain(session.id);

    cleanup();
    render(<App />);
    await screen.findByTestId('output');
    await waitFor(() => expect(screen.getByTestId('output')).toHaveTextContent('before'));
    act(() => fake.emitChunk(request.id, ' after', 4));
    await waitFor(() => expect(screen.getByTestId('output').textContent).toBe('before after'));
  });

  it('after a reload shows the last finished output by request id', async () => {
    await readySession();
    const request = await submitPrompt('Hello');
    act(() => fake.emitChunk(request.id, 'answer', 4));
    await waitFor(() => expect(screen.getByTestId('output')).toHaveTextContent('answer'));
    act(() => fake.finishRequest(request.id));
    await screen.findByText('Output complete');

    cleanup();
    render(<App />);
    await screen.findByText('Output complete');
    expect(screen.getByTestId('output').textContent).toBe('answer');
    expect(fake.callsTo('GET', new RegExp(`/requests/${request.id}$`)).length).toBeGreaterThan(0);
  });

  it('can end the session while a request is showing', async () => {
    await readySession();
    await submitPrompt('Hello');
    expect(screen.getByRole('button', {name: 'End session'})).toBeEnabled();
  });

  it('copies the finished output', async () => {
    await readySession();
    const request = await submitPrompt('Hello');
    act(() => fake.emitChunk(request.id, 'copy me', 4));
    await waitFor(() => expect(screen.getByTestId('output')).toHaveTextContent('copy me'));
    act(() => fake.finishRequest(request.id));
    await screen.findByText('Output complete');
    await user.click(screen.getByRole('button', {name: 'Copy output'}));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('copy me'));
  });

  it('does not call the output complete until the chunks are read, and a failed read can be retried', async () => {
    await readySession();
    const request = await submitPrompt('Hello');
    act(() => fake.emitChunk(request.id, 'first', 4));
    await waitFor(() => expect(screen.getByTestId('output')).toHaveTextContent('first'));
    fake.emitChunk(request.id, ' second', 4, true);
    fake.failNext('GET /requests/.*/chunks', 500, makeError({code: 'internal', message: 'Could not read chunks.'}));
    act(() => fake.finishRequest(request.id));
    await screen.findByText(/Could not read chunks/);
    expect(screen.queryByText('Output complete')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Read the output again'}));
    await screen.findByText('Output complete');
    expect(screen.getByTestId('output').textContent).toBe('first second');
  });

  it('reads the output again when a second reconnect happens during a backfill', async () => {
    await readySession();
    const request = await submitPrompt('Hello');
    const session = fake.sessions.get(request.session_id)!;
    act(() => fake.emitChunk(request.id, 'a', 4));
    await waitFor(() => expect(screen.getByTestId('output')).toHaveTextContent('a'));

    vi.useFakeTimers({shouldAdvanceTime: true});
    let held: {release: () => void};
    try {
      // First reconnect: the backfill's answer is computed now but stays on the wire.
      act(() => fake.dropSockets());
      await screen.findByRole('status');
      fake.emitChunk(request.id, 'b', 4, true);
      held = fake.holdResponse('GET /requests/.*/chunks');
      await act(() => vi.advanceTimersByTimeAsync(1100));
      await waitFor(() => expect(fake.callsTo('GET', /\/chunks$/)).toHaveLength(1));

      // Second reconnect: one more chunk, and the request ends while the first answer is still out.
      act(() => fake.dropSockets());
      await screen.findByRole('status');
      fake.emitChunk(request.id, 'c', 4, true);
      Object.assign(request, {state: 'completed', final_seq: '3', archive_state: 'saved'});
      session.active_request_ids = [];
      await act(() => vi.advanceTimersByTimeAsync(1100));
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
      await waitFor(() => expect(fake.callsTo('GET', new RegExp(`/requests/${request.id}$`)).length).toBeGreaterThan(0));
      await act(() => vi.advanceTimersByTimeAsync(10));
    } finally {
      vi.useRealTimers();
    }

    held.release();
    await screen.findByText('Output complete');
    expect(screen.getByTestId('output').textContent).toBe('abc');
  });

  it('reads more than one page of chunks', async () => {
    await readySession();
    const request = await submitPrompt('Hello');
    act(() => fake.emitChunk(request.id, 'start ', 4));
    await waitFor(() => expect(screen.getByTestId('output')).toHaveTextContent('start'));
    vi.useFakeTimers({shouldAdvanceTime: true});
    try {
      act(() => fake.dropSockets());
      await screen.findByRole('status');
      for (let i = 0; i < 1001; i += 1) fake.emitChunk(request.id, 'x', 1, true);
      await act(() => vi.advanceTimersByTimeAsync(1100));
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => expect(screen.getByTestId('output').textContent).toBe(`start ${'x'.repeat(1001)}`));
    expect(fake.callsTo('GET', /\/chunks$/).length).toBeGreaterThanOrEqual(2);
  });

  it('shows why a remembered request could not be read, and can read it again', async () => {
    await readySession();
    const request = await submitPrompt('Hello');
    act(() => fake.emitChunk(request.id, 'answer', 4));
    await waitFor(() => expect(screen.getByTestId('output')).toHaveTextContent('answer'));
    act(() => fake.finishRequest(request.id));
    await screen.findByText('Output complete');

    cleanup();
    fake.failNext('GET /requests/[^/]+$', 500, makeError({code: 'internal', phase: 'serve', message: 'Database unavailable.'}));
    render(<App />);
    await screen.findByText('serve · Database unavailable.');
    await user.click(screen.getByRole('button', {name: 'Read the request again'}));
    await screen.findByText('Output complete');
    expect(screen.getByTestId('output').textContent).toBe('answer');
  });

  it('after a reload prefers the running request over the one this browser remembers', async () => {
    const {session} = await readySession();
    const first = await submitPrompt('Hello');
    act(() => fake.emitChunk(first.id, 'first', 4));
    await waitFor(() => expect(screen.getByTestId('output')).toHaveTextContent('first'));
    act(() => fake.finishRequest(first.id));
    await screen.findByText('Output complete');

    // Another tab starts a new request while this one is closed.
    cleanup();
    const second = makeRequest({session_id: session.id, state: 'pending'});
    fake.requests.set(second.id, second);
    fake.sessions.get(session.id)!.active_request_ids = [second.id];
    fake.emitChunk(second.id, 'second', 4, true);

    render(<App />);
    await waitFor(() => expect(screen.getByTestId('output').textContent).toBe('second'));
  });

  it('offers fixed test prompts only when the backend enables them', async () => {
    await readySession();
    expect(screen.queryByLabelText('Fixed test prompt')).not.toBeInTheDocument();
  });

  it('sends only the prompt id for a fixed test prompt', async () => {
    fake.acceptance = {enabled: true, prompts: [{id: 'p1', label: 'Benchmark prompt', resource_sha256: 'a'.repeat(64), max_output_tokens: 512}]};
    await readySession();
    await user.selectOptions(await screen.findByLabelText('Fixed test prompt'), 'p1');
    await user.click(screen.getByRole('button', {name: 'Send'}));
    await screen.findByTestId('output');
    expect(fake.callsTo('POST', /\/requests$/).at(-1)!.body).toEqual({acceptance_prompt_id: 'p1'});
  });

  it('follows the session named in the response when a key returns another session', async () => {
    const {session} = await readySession();
    const other = makeSession({state: 'ready', phase: 'serve'});
    fake.sessions.set(other.id, other);
    const request = await submitPrompt('Hello');
    act(() => fake.finishRequest(request.id));
    await screen.findByText('Output complete');
    await user.click(screen.getByRole('button', {name: 'New request'}));
    // A key the server already knows returns the original request, even from another session.
    Object.assign(fake.requests.get(request.id)!, {session_id: other.id});
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce(request.submission_id as `${string}-${string}-${string}-${string}-${string}`);
    await user.type(screen.getByLabelText('Prompt'), 'Hello');
    await user.click(screen.getByRole('button', {name: 'Send'}));
    await waitFor(() => expect(window.location.hash).toContain(other.id));
    expect(window.location.hash).not.toContain(session.id);
  });
});

describe('thinking and answer', () => {
  it('folds the thinking away with its token count and shows the answer as before', async () => {
    await readySession();
    const request = await submitPrompt('What is 2 + 2?');
    act(() => fake.emitChunk(request.id, 'The user asks a sum. ', 7, false, 'think'));
    act(() => fake.emitChunk(request.id, 'Two and two make four.', 5, false, 'think'));
    const thinking = await screen.findByTestId('thinking');
    await waitFor(() => expect(within(thinking).getByText('Thinking · 12 tokens')).toBeInTheDocument());
    expect(thinking).not.toHaveAttribute('open');
    expect(within(thinking).getByText(/Two and two make four\./)).not.toBeVisible();
    act(() => fake.emitChunk(request.id, 'It is 4.', 3, false, 'answer'));
    await waitFor(() => expect(screen.getByTestId('output').textContent).toBe('It is 4.'));
    await user.click(within(thinking).getByText('Thinking · 12 tokens'));
    expect(within(thinking).getByText(/Two and two make four\./)).toBeVisible();
  });

  it('copies only the answer', async () => {
    await readySession();
    const request = await submitPrompt('Hello');
    act(() => fake.emitChunk(request.id, 'Greet back.', 3, false, 'think'));
    act(() => fake.emitChunk(request.id, 'Hello there.', 3, false, 'answer'));
    act(() => fake.finishRequest(request.id));
    await screen.findByText('Output complete');
    await user.click(screen.getByRole('button', {name: 'Copy output'}));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe('Hello there.'));
  });

  it('shows output recorded before segments as one text, without a thinking section', async () => {
    await readySession();
    const request = await submitPrompt('Hello');
    act(() => fake.emitChunk(request.id, 'thought</think>answer', 6));
    await waitFor(() => expect(screen.getByTestId('output').textContent).toBe('thought</think>answer'));
    expect(screen.queryByTestId('thinking')).not.toBeInTheDocument();
  });
});

describe('request source and history', () => {
  /** Load the page again on the same session, as after a browser reload. */
  async function reloadSession() {
    cleanup();
    render(<App />);
    await screen.findByRole('heading', {name: 'Session'});
  }

  it('says a request came from the website', async () => {
    await readySession();
    await submitPrompt('Hello');
    await screen.findByText('Sent from the website');
  });

  it('shows a request a program sent through the API while it runs, and says so', async () => {
    const {session} = await readySession();
    act(() => {fake.apiRequest(session.id);});
    const request = [...fake.requests.values()].at(-1)!;
    act(() => fake.emitChunk(request.id, 'from a program', 4, false, 'answer'));
    await waitFor(() => expect(screen.getByTestId('output')).toHaveTextContent('from a program'));
    expect(screen.getByText('Sent through the API')).toBeInTheDocument();
  });

  it('lists the session\'s recent requests with time, source, state and output tokens', async () => {
    const {session} = await readySession();
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    const older = makeRequest({session_id: session.id, state: 'failed', source: 'web', output_tokens: '9', received_at: minutesAgo(30)});
    const newer = makeRequest({session_id: session.id, state: 'completed', source: 'api', api_key_id: 'key-1', output_tokens: '120', received_at: minutesAgo(5)});
    for (const r of [older, newer]) fake.requests.set(r.id, r);
    await reloadSession();
    const history = await screen.findByTestId('request-history');
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(2));
    const [first, second] = within(history).getAllByRole('listitem');
    expect(first).toHaveTextContent('API');
    expect(first).toHaveTextContent('Completed');
    expect(first).toHaveTextContent('120 tokens');
    expect(first).toHaveTextContent('5 minutes ago');
    expect(second).toHaveTextContent('Website');
    expect(second).toHaveTextContent('Failed');
    expect(second).toHaveTextContent('30 minutes ago');
    expect(fake.callsTo('GET', new RegExp(`/sessions/${session.id}/requests$`)).at(-1)!.query).toBe('?limit=20');
  });

  it('opens a finished request from the list and shows its thinking folded and its answer', async () => {
    const {session} = await readySession();
    const done = makeRequest({session_id: session.id, state: 'running', source: 'api', api_key_id: 'key-1', received_at: new Date(Date.now() - 60_000).toISOString()});
    fake.requests.set(done.id, done);
    fake.emitChunk(done.id, 'Plan the reply.', 4, true, 'think');
    fake.emitChunk(done.id, 'Here is the reply.', 4, true, 'answer');
    Object.assign(done, {state: 'completed', final_seq: done.contiguous_seq, archive_state: 'saved'});
    await reloadSession();
    const history = await screen.findByTestId('request-history');
    const row = await within(history).findByRole('button', {name: /API/});
    expect(row).toHaveAttribute('aria-expanded', 'false');
    await user.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    const item = row.closest('li')!;
    await waitFor(() => expect(within(item).getByTestId('history-output').textContent).toBe('Here is the reply.'));
    expect(within(item).getByText('Thinking · 4 tokens')).toBeInTheDocument();
    expect(within(item).getByText('Plan the reply.')).not.toBeVisible();
    expect(fake.callsTo('GET', new RegExp(`/requests/${done.id}/chunks`)).length).toBeGreaterThan(0);
    await user.click(row);
    expect(within(item).queryByTestId('history-output')).not.toBeInTheDocument();
  });

  it('reads the list again when a request starts and when it ends', async () => {
    const {session} = await readySession();
    const reads = () => fake.callsTo('GET', new RegExp(`/sessions/${session.id}/requests$`)).length;
    await waitFor(() => expect(reads()).toBeGreaterThan(0));
    const before = reads();
    act(() => {fake.apiRequest(session.id);});
    const request = [...fake.requests.values()].at(-1)!;
    await waitFor(() => expect(reads()).toBeGreaterThan(before));
    const history = screen.getByTestId('request-history');
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(1));
    expect(within(history).getByRole('listitem')).toHaveTextContent('Running');
    const started = reads();
    act(() => fake.finishRequest(request.id));
    await waitFor(() => expect(reads()).toBeGreaterThan(started));
    await waitFor(() => expect(within(history).getByRole('listitem')).toHaveTextContent('Completed'));
  });

  it('says when the session has no requests yet, and shows a failed read with a retry', async () => {
    const {session} = await readySession();
    const history = await screen.findByTestId('request-history');
    await within(history).findByText('No requests yet.');
    fake.failNext(`GET /sessions/${session.id}/requests$`, 500, makeError({code: 'internal_error', message: 'Database unavailable.'}));
    act(() => {fake.apiRequest(session.id);});
    await within(history).findByText(/Database unavailable\./);
    await user.click(within(history).getByRole('button', {name: 'Read the list again'}));
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(1));
    expect(within(history).queryByText(/Database unavailable\./)).not.toBeInTheDocument();
  });
});

describe('API keys', () => {
  async function openKeys() {
    await register();
    await user.click(screen.getByRole('link', {name: 'API keys'}));
    await screen.findByRole('heading', {name: 'API keys'});
  }

  it('generates a key, shows it once, then lists it by name and hint only', async () => {
    await openKeys();
    await user.type(screen.getByLabelText('Key name'), 'laptop scripts');
    await user.click(screen.getByRole('button', {name: 'Generate key'}));
    const secret = await waitFor(() => fake.lastSecret!);
    expect(await screen.findByText(secret)).toBeInTheDocument();
    expect(screen.getByText(/shown only once/i)).toBeInTheDocument();
    expect(fake.callsTo('POST', /^\/api-keys$/).at(-1)!.body).toEqual({name: 'laptop scripts'});
    const list = screen.getByTestId('api-keys');
    const row = (await within(list).findByText('laptop scripts')).closest('li')!;
    expect(row).toHaveTextContent(`oi_…${secret.slice(-4)}`);
    expect(row).toHaveTextContent('Never used');
    expect(row).not.toHaveTextContent(secret);
    await user.click(screen.getByRole('button', {name: 'Copy key'}));
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe(secret));
    await user.click(screen.getByRole('button', {name: 'Done'}));
    expect(document.body.textContent).not.toContain(secret);
    cleanup();
    render(<App />);
    await screen.findByRole('heading', {name: 'API keys'});
    await within(screen.getByTestId('api-keys')).findByText('laptop scripts');
    expect(document.body.textContent).not.toContain(secret);
  });

  it('asks for a name of 1 to 80 characters without calling the server', async () => {
    await openKeys();
    await user.click(screen.getByRole('button', {name: 'Generate key'}));
    await screen.findByText('Enter a name for the key.');
    await user.type(screen.getByLabelText('Key name'), 'x'.repeat(81));
    await user.click(screen.getByRole('button', {name: 'Generate key'}));
    await screen.findByText('Use at most 80 characters.');
    expect(fake.callsTo('POST', /^\/api-keys$/)).toHaveLength(0);
  });

  it('shows why generating failed and keeps the name', async () => {
    await openKeys();
    fake.failNext('POST /api-keys$', 500, makeError({code: 'internal_error', message: 'Database unavailable.'}));
    await user.type(screen.getByLabelText('Key name'), 'ci');
    await user.click(screen.getByRole('button', {name: 'Generate key'}));
    await screen.findByText('Database unavailable.');
    expect(screen.getByLabelText('Key name')).toHaveValue('ci');
    expect(fake.apiKeys.size).toBe(0);
  });

  it('lists when each key was last used and which are revoked', async () => {
    const recent = new Date(Date.now() - 3 * 60_000).toISOString();
    for (const key of [
      makeApiKey({name: 'used', last_used_at: recent, created_at: '2026-11-08T12:00:02Z'}),
      makeApiKey({name: 'unused', created_at: '2026-11-08T12:00:01Z'}),
      makeApiKey({name: 'old', revoked_at: '2026-11-08T13:00:00Z', created_at: '2026-11-08T12:00:00Z'}),
    ]) fake.apiKeys.set(key.id, key);
    await openKeys();
    const list = screen.getByTestId('api-keys');
    await within(list).findByText('used');
    const [used, unused, old] = within(list).getAllByRole('listitem');
    expect(used).toHaveTextContent('Last used 3 minutes ago');
    expect(unused).toHaveTextContent('Never used');
    expect(old).toHaveTextContent('Revoked');
    expect(within(old).queryByRole('button', {name: 'Revoke'})).not.toBeInTheDocument();
    expect(within(used).getByRole('button', {name: 'Revoke'})).toBeEnabled();
  });

  it('revokes a key only after confirming, and marks it revoked', async () => {
    const key = makeApiKey({name: 'editor'});
    fake.apiKeys.set(key.id, key);
    await openKeys();
    const row = (await within(screen.getByTestId('api-keys')).findByText('editor')).closest('li')!;
    await user.click(within(row).getByRole('button', {name: 'Revoke'}));
    expect(within(row).getByText(/Programs using this key stop working/)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', {name: 'Cancel'}));
    expect(fake.callsTo('POST', /revoke$/)).toHaveLength(0);
    await user.click(within(row).getByRole('button', {name: 'Revoke'}));
    await user.click(within(row).getByRole('button', {name: 'Revoke key'}));
    await within(row).findByText('Revoked');
    expect(fake.callsTo('POST', new RegExp(`/api-keys/${key.id}/revoke$`))).toHaveLength(1);
    expect(within(row).queryByRole('button', {name: 'Revoke'})).not.toBeInTheDocument();
  });

  it('marks only the example code blocks as showing field names; the rest of the page passes the leak check', async () => {
    fake.apiKeys.set('k', makeApiKey({name: 'editor plugin', last_used_at: new Date().toISOString()}));
    await openKeys();
    await within(screen.getByTestId('api-keys')).findByText('editor plugin');
    const blocks = [...screen.getByTestId('api-usage').querySelectorAll('pre')];
    expect(blocks.length).toBeGreaterThan(0);
    expect([...document.querySelectorAll('[data-leak-exempt]')]).toEqual(blocks);
    expect(findLeak(checkedText(document.body))).toBeNull();
  });

  it('shows the base address, the model name and how to call the API', async () => {
    // the model and its context length are the catalog's, whatever it holds
    fake.catalog = {...fake.catalog, models: {'some-model': {context_length: 2048}},
                    versions: fake.catalog.versions.map((v) => ({...v, model: 'some-model'}))};
    await openKeys();
    const usage = screen.getByTestId('api-usage');
    expect(usage).toHaveTextContent(`${window.location.origin}/v1`);
    await within(usage).findByText('some-model');
    expect(usage).toHaveTextContent('Each request has 2048 tokens');
    expect(usage).not.toHaveTextContent('Qwen');
    const examples = [...usage.querySelectorAll('pre')].map((pre) => pre.textContent ?? '');
    expect(examples.filter((e) => e.includes('"model": "some-model"') || e.includes('model="some-model"'))).toHaveLength(2);
    expect(examples.some((e) => e.includes('curl') && e.includes('--cacert') && e.includes('Authorization: Bearer $OPENINFER_API_KEY') && e.includes(`${window.location.origin}/v1/chat/completions`))).toBe(true);
    expect(examples.some((e) => e.includes('from openai import OpenAI') && e.includes(`base_url="${window.location.origin}/v1"`) && e.includes('reasoning_content'))).toBe(true);
    expect(examples.some((e) => /SSL_CERT_FILE=\S+ python/.test(e))).toBe(true);
    expect(usage).not.toHaveTextContent(/verify=False|-k |--insecure/);
  });

  it('names the certificate file the server loaded, on the machine that runs the server', async () => {
    fake.certificatePath = '~/work/cp/tls.crt';
    await openKeys();
    const usage = screen.getByTestId('api-usage');
    await within(usage).findByText('~/work/cp/tls.crt');
    expect(usage).toHaveTextContent('on the machine that runs the server');
    expect(usage).not.toHaveTextContent(/on the Mac|when it was installed/);
    expect(usage).toHaveTextContent(/simulated/);
    expect(usage).not.toHaveTextContent('~/openinfer');
    expect(findLeak(checkedText(document.body))).toBeNull();
  });
});
