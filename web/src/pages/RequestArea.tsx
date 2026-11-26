import {useEffect, useReducer, useState, type ChangeEvent, type FormEvent, type ReactNode} from 'react';
import {ChevronRight} from 'lucide-react';
import {describeError, type ApiError} from '@/api/errors';
import type {AcceptancePrompt, PromptFile, Request, RequestSummary, SessionSummary} from '@/api/types';
import {Alert, AlertDescription} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {StatusIcon} from '@/components/status';
import {Card, CardContent, CardHeader} from '@/components/ui/card';
import {Pill, type Tone} from '@/components/ui/pill';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {NativeSelect, NativeSelectOption} from '@/components/ui/native-select';
import {Textarea} from '@/components/ui/textarea';
import {navigate} from '@/lib/route';
import {saveFile} from '@/lib/saveFile';
import {useAction} from '@/lib/useAction';
import {helperShare} from '@/state/helperShare';
import type {HeldRequest} from '@/state/live';
import {emptyOutput, isOutputComplete, isTerminalRequest, type OutputState} from '@/state/output';
import {splitOutput} from '@/state/outputParts';
import {initialPanel, panelReducer, promptFileProblem, promptFileSize, validateDraft} from '@/state/requestPanel';
import {computeSpeed, formatSpeed} from '@/state/speed';
import {useBackfill} from './useBackfill';
import {useStore} from './Workspace';

type Props = {session: SessionSummary; canSubmit: boolean; blockedReason: string | null};
const EXAMPLE_PROMPT = 'Show a sample request moving through OpenInfer.';

export const STATE: Record<Request['state'], {label: string; tone: Tone}> = {
  pending: {label: 'Queued', tone: 'neutral'},
  running: {label: 'Running', tone: 'info'},
  recovering: {label: 'Saving', tone: 'info'},
  cancelling: {label: 'Stopping', tone: 'warning'},
  completed: {label: 'Completed', tone: 'success'},
  failed: {label: 'Failed', tone: 'danger'},
  cancelled: {label: 'Cancelled', tone: 'neutral'},
};

export function RequestArea({session, canSubmit, blockedReason}: Props) {
  const {client, dispatchLive, live, memory, devices, stale} = useStore();
  const [panel, dispatch] = useReducer(panelReducer, initialPanel);
  const [acceptance, setAcceptance] = useState<AcceptancePrompt[]>([]);

  useEffect(() => {
    client
      .get<{enabled: boolean; prompts: AcceptancePrompt[]}>('/acceptance-prompts')
      .then((r) => setAcceptance(r.enabled ? r.prompts : []))
      .catch(() => setAcceptance([]));
  }, [client]);

  // After a reload the server is asked by ID: the active request if there is one, else the last one this browser saw.
  const activeId = session.active_request_ids[0];
  useEffect(() => {
    const remembered = memory.requestFor(session.id);
    if (remembered && !session.active_request_ids[0]) dispatch({type: 'resume', requestId: remembered});
  }, [memory, session.id]);
  useEffect(() => {
    if (activeId) dispatch({type: 'resume', requestId: activeId});
  }, [activeId, panel.phase]);

  const requestId = panel.phase === 'showing' || panel.phase === 'terminal' ? panel.requestId : null;
  const request = requestId ? live.requests[requestId] : undefined;
  const output = (requestId && live.outputs[requestId]) || emptyOutput;
  const complete = request ? isOutputComplete(request, output) : false;

  useEffect(() => {
    if (requestId) memory.rememberRequest(session.id, requestId);
  }, [memory, session.id, requestId]);

  useEffect(() => {
    if (request) dispatch({type: 'observe', request, complete});
  }, [request, complete]);

  const missing = requestId !== null && !request;
  const {snapshotCount} = live;
  const [readError, setReadError] = useState<ApiError | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  useEffect(() => {
    if (!requestId || !missing) return;
    setReadError(null);
    client
      .get<Request>(`/requests/${requestId}`)
      .then((r) => dispatchLive({type: 'request_loaded', request: r}))
      .catch((e) => {
        if ((e as ApiError).status === 404) {
          memory.forgetRequest(session.id);
          dispatch({type: 'new_request'});
        } else {
          setReadError(e as ApiError);
        }
      });
  }, [client, dispatchLive, memory, requestId, missing, session.id, snapshotCount, readAttempt]);

  const backfill = useBackfill(requestId, request, snapshotCount);

  async function send(key: string) {
    const checked = validateDraft(panel.draft);
    if (!checked.ok) return;
    try {
      const {request: created} = await client.post<{request: Request}>(`/sessions/${session.id}/requests`, checked.input, {idempotencyKey: key});
      if (created.session_id !== session.id) {
        memory.rememberRequest(created.session_id, created.id);
        navigate(`#/sessions/${created.session_id}`);
        return;
      }
      dispatch({type: 'created', requestId: created.id});
    } catch (e) {
      const error = e as ApiError;
      if (error.outcomeUnknown) dispatch({type: 'timeout'});
      else dispatch({type: error.code === 'request_busy' ? 'busy' : 'rejected', message: describeError(error.body, devices)});
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (panel.phase !== 'editing') return;
    const key = panel.key ?? crypto.randomUUID();
    dispatch({type: 'submit', key});
    if (validateDraft(panel.draft).ok) void send(key);
  }

  function retry() {
    if (panel.phase !== 'submitting') return;
    dispatch({type: 'retry'});
    void send(panel.key);
  }

  // A prompt from a file: the file is uploaded when it is chosen, and the request then names it.
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const upload = useAction(async (file: File) => {
    const {file: stored} = await client.upload<{file: PromptFile}>('/files', file);
    dispatch({type: 'edit', patch: {file: {id: stored.id, name: stored.name, size_bytes: stored.size_bytes}}});
  });
  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const problem = promptFileProblem(file.name, file.size);
    setFileProblem(problem);
    if (!problem) void upload.run(file);
  }

  const copy = useAction(() => navigator.clipboard.writeText(output.answer));
  const usable = session.state === 'ready' || session.state === 'degraded';

  return (
    <Card>
      <CardHeader title="Request" description="One request at a time. The output appears as the server confirms it." />
      <CardContent className="flex flex-col gap-5">
        {panel.phase === 'editing' && (
          <form className="flex flex-col gap-3" onSubmit={submit}>
            {acceptance.length > 0 && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="fixed-prompt">Fixed test prompt</Label>
                <NativeSelect id="fixed-prompt" className="w-full" value={panel.draft.acceptanceId ?? ''}
                              onChange={(e) => dispatch({type: 'edit', patch: {acceptanceId: e.target.value || null}})}>
                  <NativeSelectOption value="">None</NativeSelectOption>
                  {acceptance.map((p) => <NativeSelectOption key={p.id} value={p.id}>{p.label}</NativeSelectOption>)}
                </NativeSelect>
              </div>
            )}
            {!panel.draft.acceptanceId && !panel.draft.file && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="prompt">Prompt</Label>
                  <Button type="button" variant="link" disabled={!usable}
                          onClick={() => dispatch({type: 'edit', patch: {prompt: EXAMPLE_PROMPT}})}>
                    Use example prompt
                  </Button>
                </div>
                <Textarea id="prompt" rows={5} disabled={!usable} value={panel.draft.prompt}
                          onChange={(e) => dispatch({type: 'edit', patch: {prompt: e.target.value}})} />
              </div>
            )}
            {!panel.draft.acceptanceId && (
              <div className="flex flex-col gap-2">
                {panel.draft.file ? (
                  <>
                    <span className="text-sm font-medium">Prompt from a file</span>
                    <div data-testid="prompt-file" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-subtle px-3.5 py-2.5 text-sm">
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        <FileLink file={panel.draft.file} /> <span className="text-muted-foreground">· {promptFileSize(panel.draft.file.size_bytes)}</span>
                      </span>
                      <Button type="button" size="sm" variant="outline" onClick={() => dispatch({type: 'edit', patch: {file: null}})}>Remove file</Button>
                    </div>
                  </>
                ) : (
                  <>
                    <Label htmlFor="prompt-file">Prompt from a file</Label>
                    <Input id="prompt-file" type="file" accept=".txt,.md,text/plain,text/markdown" disabled={!usable || upload.pending} onChange={chooseFile} />
                  </>
                )}
                <p data-testid="prompt-file-note" className="text-[13px] text-muted-foreground">
                  {panel.draft.file
                    ? `The request reads its prompt from this file and keeps a link to it.${live.storage ? ` The file is ${KEPT[live.storage]}.` : ''}`
                    : `Instead of typing: a .txt or .md file of up to 64 KiB.${live.storage ? ` It is uploaded and ${KEPT[live.storage]}.` : ''}`}
                </p>
                {fileProblem && <p className="text-[13px] text-danger">{fileProblem}</p>}
                {upload.error && <p className="text-[13px] break-words text-danger">{describeError(upload.error.body, devices)}</p>}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              {!panel.draft.acceptanceId && (
                <div className="flex min-w-0 flex-col gap-2">
                  <Label htmlFor="max-output">Maximum output (tokens)</Label>
                  <Input id="max-output" inputMode="numeric" placeholder="Default: what fits" value={panel.draft.maxOutput}
                         onChange={(e) => dispatch({type: 'edit', patch: {maxOutput: e.target.value}})} />
                </div>
              )}
            </div>
            {panel.error && <Alert variant="destructive"><AlertDescription>{panel.error}</AlertDescription></Alert>}
            {blockedReason && usable && <p className="text-sm text-muted-foreground">{blockedReason}</p>}
            <div className="flex flex-wrap items-center gap-3 border-t pt-4">
              <Button type="submit" disabled={!canSubmit}>Send</Button>
            </div>
          </form>
        )}

        {panel.phase === 'submitting' && !panel.uncertain && (
          <Button className="self-start" disabled>Sending…</Button>
        )}
        {panel.phase === 'submitting' && panel.uncertain && (
          <>
            <p className="text-sm">No response from the server. The request may have been received. Trying again will not start a second one.</p>
            <div className="flex flex-wrap gap-2">
              <Button disabled={stale} onClick={retry}>Try again</Button>
              <Button variant="outline" onClick={() => dispatch({type: 'back_to_edit'})}>Back to editing</Button>
            </div>
            {stale && <p className="text-sm text-muted-foreground">{blockedReason}</p>}
          </>
        )}

        {requestId && <RequestOutput output={output} request={request} />}
        {missing && readError && (
          <Alert variant="destructive">
            <AlertDescription>
              {describeError(readError.body, devices)}{' '}
              <Button size="sm" variant="outline" onClick={() => setReadAttempt((n) => n + 1)}>Read the request again</Button>
            </AlertDescription>
          </Alert>
        )}
        {request?.error && <Alert variant="destructive"><AlertDescription>{describeError(request.error, devices)}</AlertDescription></Alert>}
        {request?.archive_state === 'failed' && request.archive_error && request.archive_error.code !== request.error?.code && (
          <Alert variant="destructive"><AlertDescription>{describeError(request.archive_error, devices)}</AlertDescription></Alert>
        )}
        {panel.phase === 'showing' && request && isTerminalRequest(request.state) && !complete && (
          <p className="text-sm text-muted-foreground">Reading the rest of the output…</p>
        )}
        {backfill.error && (
          <Alert variant="destructive">
            <AlertDescription>
              {describeError(backfill.error.body, devices)}{' '}
              <Button size="sm" variant="outline" onClick={backfill.retry}>Read the output again</Button>
            </AlertDescription>
          </Alert>
        )}
        {panel.phase === 'terminal' && (
          <div className="flex flex-col gap-3 border-t pt-4">
            {request?.state === 'completed' && (
              <p className="flex items-center gap-2.5 text-sm"><StatusIcon status="done" /><span>Output complete</span></p>
            )}
            {request && <HelperShareLine request={request} />}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" disabled={copy.pending} onClick={() => void copy.run()}>Copy output</Button>
              <Button variant="outline" onClick={() => {memory.forgetRequest(session.id); dispatch({type: 'new_request'});}}>New request</Button>
            </div>
            {copy.error && <p className="text-xs text-destructive">Could not copy the output.</p>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({label, value, testId}: {label: string; value: ReactNode; testId?: string}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-card px-4 py-3">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd data-testid={testId} className="text-[15px] font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

export const SOURCE: Record<Request['source'], string> = {web: 'Website', api: 'API'};

function RequestOutput({output, request}: {output: OutputState; request: HeldRequest | undefined}) {
  const speed = request ? computeSpeed(request.timing, request.output_tokens) : {endToEnd: null, decode: null};
  const state = request ? STATE[request.state] : null;
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
        <Stat label="State" testId="request-state" value={state ? <Pill tone={state.tone}>{state.label}</Pill> : 'Loading'} />
        <Stat label="Output tokens" value={request?.output_tokens ?? '0'} />
        <Stat label="End-to-end" testId="speed-end-to-end" value={formatSpeed(speed.endToEnd)} />
        <Stat label="Decode" testId="speed-decode" value={formatSpeed(speed.decode)} />
      </dl>
      <p data-testid="simulated-note" className="text-[13px] text-muted-foreground">The devices are simulated: these speeds are computed from the simulator's output, whose pace and helper's share are settings, not measurements.</p>
      {request && (
        <p className="text-[13px] text-muted-foreground">{request.source === 'api' ? 'Sent through the API' : 'Sent from the website'}</p>
      )}
      {request && <RequestFiles request={request} />}
      <OutputView output={output} testId="output" />
    </div>
  );
}

// Where the server keeps uploaded files and saved results (Snapshot.storage), in the words the page uses for it.
const KEPT = {
  bucket: 'kept in the storage bucket',
  memory: 'kept only in the memory of the server process, because no storage bucket is configured, and lost when the server restarts',
};

/** A link that fetches PATH and saves it as NAME; when the server refuses (the object is no longer stored), its reason is shown beside the link. */
function Download({path, name, children}: {path: string; name: string; children: ReactNode}) {
  const {client, devices} = useStore();
  const save = useAction(async () => saveFile(await client.download(path), name));
  return (
    <>
      <a className="font-medium text-foreground underline underline-offset-4 [overflow-wrap:anywhere]" href={`/api/v1${path}`} download={name}
         onClick={(event) => { event.preventDefault(); void save.run(); }}>{children}</a>
      {save.error && <span role="alert" className="block break-words text-danger">{describeError(save.error.body, devices)}</span>}
    </>
  );
}

function FileLink({file}: {file: PromptFile}) {
  return <Download path={`/files/${file.id}/content`} name={file.name}>{file.name}</Download>;
}

/** What the server keeps for a request, as downloads: the file its prompt came from, and its result once saved; and where they are kept. */
export function RequestFiles({request}: {request: RequestSummary}) {
  const {live} = useStore();
  const saved = request.archive_state === 'saved';
  if (!request.prompt_file && !saved) return null;
  return (
    <div data-testid="request-files" className="flex flex-col gap-1 text-[13px] text-muted-foreground">
      <p className="flex flex-wrap gap-x-5 gap-y-1">
        {request.prompt_file && <span>Prompt from the file <FileLink file={request.prompt_file} /></span>}
        {saved && <span><Download path={`/requests/${request.id}/result?download=1`} name={`request-${request.id}.json`}>Download result</Download></span>}
      </p>
      {live.storage && <p>Downloads are {KEPT[live.storage]}.</p>}
    </div>
  );
}

function tokens(n: number): string {
  return `${n} ${n === 1 ? 'token' : 'tokens'}`;
}

/** The thinking, folded away under its token count, then the answer. Output from before the two were told apart is all answer. */
export function OutputView({output, testId}: {output: OutputState; testId: string}) {
  return (
    <>
      {(output.think !== '' || output.thinkTokens > 0) && (
        <details data-testid="thinking" className="group text-sm">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-[13px] text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="size-3.5 transition-transform group-open:rotate-90" />
            <span>{`Thinking · ${tokens(output.thinkTokens)}`}</span>
          </summary>
          <div className="mt-2 rounded-lg border bg-subtle px-4 py-3 text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-muted-foreground">
            {output.think}
          </div>
        </details>
      )}
      <OutputText text={output.answer} testId={testId} />
    </>
  );
}

/** Model output as text, never as markup; fenced code blocks in a monospace box. */
function OutputText({text, testId}: {text: string; testId: string}) {
  return (
    <div data-testid={testId} className="flex min-h-28 flex-col gap-3 rounded-lg border bg-card px-4 py-3.5 text-sm leading-relaxed">
      {splitOutput(text).map((part, index) => part.kind === 'text'
        // Blank lines at the edges of a text part would add to the gap around a code block.
        ? <div key={index} className="whitespace-pre-wrap [overflow-wrap:anywhere]">{part.text.replace(/^\n+|\n+$/g, '')}</div>
        : (
          <div key={index} className="overflow-hidden rounded-lg border bg-subtle">
            {part.language && <div className="border-b px-3 py-1.5 font-mono text-xs text-muted-foreground">{part.language}</div>}
            <pre className="px-3 py-2.5 font-mono text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"><code>{part.text}</code></pre>
          </div>
        ))}
    </div>
  );
}

function HelperShareLine({request}: {request: HeldRequest}) {
  const text = helperShare(request.statistics, request.output_tokens);
  if (!text) return null;
  return <p data-testid="helper-share" className="text-sm text-muted-foreground">{text}</p>;
}
