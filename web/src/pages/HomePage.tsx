import {useEffect, useState} from 'react';
import type {RequestSummary} from '@/api/types';
import {PageHeader} from '@/components/page';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader} from '@/components/ui/card';
import {Pill} from '@/components/ui/pill';
import {isOnline, usableHelperTest} from '@/state/connectivity';
import {useStore} from './Workspace';

type Step = {title: string; detail: string; done: boolean; href: string; action: string};

export function HomePage() {
  const {client, devices, live, tests, stale} = useStore();
  const [recentRequests, setRecentRequests] = useState<RequestSummary[]>([]);
  const online = devices.filter(isOnline);
  const sessions = Object.values(live.sessions).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const session = sessions.find((s) => s.state === 'ready' || s.state === 'degraded' || s.state === 'starting') ?? sessions[0];
  const sessionId = session?.id;

  // Finished requests are absent from the live snapshot. Read the selected session's history
  // through the existing API so the last step remains accurate after a page refresh.
  useEffect(() => {
    setRecentRequests([]);
    if (!sessionId) return;
    let current = true;
    client.get<{requests: RequestSummary[]}>(`/sessions/${sessionId}/requests?limit=20`)
      .then((result) => {if (current) setRecentRequests(result.requests);})
      .catch(() => {});
    return () => {current = false;};
  }, [client, sessionId, live.snapshotCount, session?.active_request_ids[0]]);

  const hasPair = online.length >= 2;
  const hasTest = online.some((service) => online.some((helper) =>
    helper.id !== service.id && usableHelperTest(tests, helper.id, service.id)));
  const hasSession = !!session && (session.state === 'ready' || session.state === 'degraded');
  const completed = recentRequests.find((request) => request.state === 'completed');
  const sessionHref = session ? `#/sessions/${session.id}` : '#/sessions/new';
  const steps: Step[] = [
    {title: 'Connect devices', detail: `${online.length} online · A serving device and helper are used in this demo.`, done: hasPair, href: '#/devices', action: 'Open devices'},
    {title: 'Check the connection', detail: 'Test the path from the helper to the serving device.', done: hasTest || hasSession, href: '#/devices', action: 'Open connection tests'},
    {title: 'Start a session', detail: hasSession ? `Session is ${session.state}.` : 'Choose devices and pass the startup checks.', done: hasSession, href: hasSession ? sessionHref : '#/sessions/new', action: hasSession ? 'Open session' : 'Create session'},
    {title: 'Send a request', detail: completed ? 'A completed result is ready to view.' : 'Watch the output arrive live, then download the result.', done: !!completed, href: sessionHref, action: completed ? 'View result' : 'Open request area'},
  ];
  const next = steps.find((step) => !step.done) ?? steps[3];

  return (
    <>
      <PageHeader title="Home" description="Follow one request from connected devices to a saved result." aside={<Pill tone="neutral">Simulated devices</Pill>} />
      <Card>
        <CardHeader title="Run an inference session" description="The device agents simulate model execution. No model runs; their speeds are configured demo values." />
        <CardContent className="flex flex-col gap-5">
          <ol className="grid gap-3 sm:grid-cols-2">
            {steps.map((step, index) => (
              <li key={step.title} className="flex min-w-0 flex-col gap-2 rounded-lg border bg-subtle p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{index + 1}. {step.title}</span>
                  <Pill tone={step.done ? 'success' : 'neutral'}>{step.done ? 'Done' : step === next ? 'Next' : 'Pending'}</Pill>
                </div>
                <p className="text-sm text-muted-foreground">{step.detail}</p>
                <a className="self-start text-sm font-medium text-primary underline-offset-4 hover:underline" href={step.href}>{step.action}</a>
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <div className="flex flex-col gap-1">
              <span className="font-medium">{stale ? 'Waiting for live status' : `Next: ${next.title}`}</span>
              <span className="text-sm text-muted-foreground">{stale ? 'The connection is not current. Reconnect before starting a new action.' : next.detail}</span>
            </div>
            {!stale && <Button asChild><a href={next.href}>{next.action}</a></Button>}
          </div>
        </CardContent>
      </Card>
      {session && <p className="text-sm text-muted-foreground">Latest session: <a className="text-primary underline-offset-4 hover:underline" href={sessionHref}>{session.model} · {session.state}</a></p>}
    </>
  );
}
