import {createContext, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode} from 'react';
import {LogOut, WifiOff} from 'lucide-react';
import type {ApiClient} from '@/api/client';
import {describeError} from '@/api/errors';
import type {ConnectionTest, Device, DeviceSummary, Identity, WsMessage} from '@/api/types';
import {Alert, AlertDescription} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {LiveSocket} from '@/lib/liveSocket';
import {BrowserMemory} from '@/lib/memory';
import {useRoute} from '@/lib/route';
import {useAction} from '@/lib/useAction';
import {cn} from '@/lib/utils';
import {enrollmentReducer, initialEnrollment, type EnrollmentEvent, type EnrollmentState} from '@/state/enrollment';
import {initialLive, isStale, liveReducer, type LiveEvent, type LiveState} from '@/state/live';
import {ApiKeysPage} from './ApiKeysPage';
import {HomePage} from './HomePage';
import {DevicesPage} from './DevicesPage';
import {NewSessionPage} from './NewSessionPage';
import {SessionPage} from './SessionPage';
import {SessionsPage} from './SessionsPage';

type Store = {
  client: ApiClient;
  live: LiveState;
  dispatchLive: Dispatch<LiveEvent>;
  enrollment: EnrollmentState;
  dispatchEnrollment: Dispatch<EnrollmentEvent>;
  memory: BrowserMemory;
  stale: boolean;
  devices: DeviceSummary[];
  tests: ConnectionTest[];
};

const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  return useContext(StoreContext) as Store;
}

type Props = {identity: Identity; client: ApiClient; onSignedOut: () => void};

/** A full-width strip under the header while the live connection is down. */
function ConnectionBanner({children}: {children: ReactNode}) {
  return (
    <div role="status" className="border-b border-warning/25 bg-warning-soft">
      <div className="mx-auto flex w-full max-w-5xl items-start gap-2.5 px-4 py-2.5 text-sm sm:px-6">
        <WifiOff aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
      </div>
    </div>
  );
}

export function Workspace({identity, client, onSignedOut}: Props) {
  const [live, dispatchLive] = useReducer(liveReducer, initialLive);
  const [enrollment, dispatchEnrollment] = useReducer(enrollmentReducer, initialEnrollment);
  const memory = useMemo(() => new BrowserMemory(identity.user_id), [identity.user_id]);
  const route = useRoute();
  const signOut = useAction(async () => {
    await client.post('/auth/logout', {});
    onSignedOut();
  });

  const signedOutRef = useRef(onSignedOut);
  signedOutRef.current = onSignedOut;

  useEffect(() => {
    const socket = new LiveSocket({
      onDisconnected: () => dispatchLive({type: 'disconnected'}),
      onRefused: (reason) => dispatchLive({type: 'refused', reason}),
      // A 401 from here signs out through the client's hook; anything else keeps retrying.
      onHandshakeFailed: () => void client.get('/auth/me').catch(() => {}),
      onExpired: () => {
        dispatchLive({type: 'session_expired'});
        signedOutRef.current();
      },
      onMessage: (message: WsMessage) => {
        dispatchLive({type: 'message', message});
        if (message.type === 'enrollment.updated') dispatchEnrollment({type: 'updated', enrollment: message.payload});
        if (message.type === 'connection_test.updated') {
          memory.rememberTest(message.payload.source_device_id, message.payload.target_device_id, message.payload.id);
        }
      },
    });
    socket.start();
    return () => socket.stop();
  }, [client, memory]);

  // A snapshot leaves out device details and finished tests, so read them by ID.
  const heldTests = useRef(live.connectionTests);
  heldTests.current = live.connectionTests;
  const devices = useMemo(() => Object.values(live.devices).filter((d) => d.state !== 'removed'), [live.devices]);
  const devicesAtSnapshot = useRef(devices);
  devicesAtSnapshot.current = devices;

  useEffect(() => {
    if (live.snapshotCount === 0) return;
    dispatchEnrollment({type: 'devices_seen', devices: devicesAtSnapshot.current});
    for (const device of devicesAtSnapshot.current) {
      client.get<Device>(`/devices/${device.id}`).then((d) => dispatchLive({type: 'device_loaded', device: d})).catch(() => {});
    }
    for (const id of memory.testIds()) {
      if (id in heldTests.current) continue;
      client.get<ConnectionTest>(`/connection-tests/${id}`).then((t) => dispatchLive({type: 'test_loaded', test: t})).catch(() => {});
    }
  }, [live.snapshotCount, client, memory]);

  useEffect(() => {
    if (enrollment.status !== 'awaiting_device') return;
    const delay = Date.parse(enrollment.enrollment.expires_at) - Date.now() + 1000;
    const timer = setTimeout(() => dispatchEnrollment({type: 'clock', now: new Date().toISOString()}), Math.max(delay, 0));
    return () => clearTimeout(timer);
  }, [enrollment]);

  const stale = isStale(live);
  const tests = useMemo(() => Object.values(live.connectionTests), [live.connectionTests]);
  const store: Store = {client, live, dispatchLive, enrollment, dispatchEnrollment, memory, stale, devices, tests};

  const sessionsActive = route.page === 'sessions' || route.page === 'new_session' || route.page === 'session';
  const navLink = (href: string, label: string, active: boolean) => (
    <a href={href} aria-current={active ? 'page' : undefined}
       className={cn('rounded-md px-1.5 py-1.5 text-sm whitespace-nowrap transition-colors sm:px-2.5', active ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')}>
      {label}
    </a>
  );

  return (
    <StoreContext.Provider value={store}>
      <div className="flex min-h-svh flex-col">
        <header className="border-b bg-card">
          <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-2 px-4 sm:gap-5 sm:px-6">
            <span className="text-[15px] font-semibold tracking-tight">OpenInfer</span>
            <nav className="flex items-center gap-1">
              {navLink('#/home', 'Home', route.page === 'home')}
              {navLink('#/devices', 'Devices', route.page === 'devices')}
              {navLink('#/sessions', 'Sessions', sessionsActive)}
              {navLink('#/api-keys', 'API keys', route.page === 'api_keys')}
            </nav>
            <div className="ml-auto flex min-w-0 items-center gap-3">
              <span className="hidden truncate text-[13px] text-muted-foreground sm:block">{identity.email}</span>
              {/* Icon only at phone width, so three links and the button fit in 360 px. */}
              <Button variant="outline" size="sm" aria-label="Sign out" disabled={signOut.pending} onClick={() => void signOut.run()}>
                <LogOut aria-hidden className="sm:hidden" /><span className="hidden sm:inline">Sign out</span>
              </Button>
            </div>
          </div>
        </header>
        {live.connection === 'reconnecting' && (
          <ConnectionBanner>
            Connection lost. This page shows the last known state and may be out of date. Reconnecting…
          </ConnectionBanner>
        )}
        {live.connection === 'refused' && (
          <ConnectionBanner>
            Connection closed. {live.refusedReason} This page shows the last known state. Refresh the page to connect again.
          </ConnectionBanner>
        )}
        <main className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-6 px-4 py-8 sm:px-6">
          {signOut.error && <Alert variant="destructive"><AlertDescription>{describeError(signOut.error.body, devices)}</AlertDescription></Alert>}
          {live.connection === 'connecting' && <p className="text-sm text-muted-foreground">Connecting…</p>}
          {route.page === 'home' && <HomePage />}
          {route.page === 'devices' && <DevicesPage />}
          {route.page === 'sessions' && <SessionsPage />}
          {route.page === 'new_session' && <NewSessionPage />}
          {route.page === 'session' && <SessionPage key={route.id} sessionId={route.id} />}
          {route.page === 'api_keys' && <ApiKeysPage />}
        </main>
      </div>
    </StoreContext.Provider>
  );
}
