import type {
  BridgeLike,
  LoomWorker,
  NostrEvent,
  RerunDraft,
  RepoContextNormalized,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowStatus,
} from './types';
import { toRepoNostrUrl } from './nip07';

const FALLBACK_RELAYS = ['wss://relay.sharegap.net', 'wss://nos.lol'];

function dedupe(values: string[]): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))
  );
}

function tagValue(
  event: Pick<NostrEvent, 'tags'> | null | undefined,
  name: string
): string | undefined {
  return event?.tags?.find((tag) => tag[0] === name)?.[1];
}

function tagValues(event: Pick<NostrEvent, 'tags'> | null | undefined, name: string): string[] {
  return (
    event?.tags
      ?.filter((tag) => tag[0] === name)
      .map((tag) => tag[1])
      .filter((value): value is string => typeof value === 'string' && value.length > 0) ?? []
  );
}

function workflowNameFromPath(workflowPath?: string): string {
  if (!workflowPath) return 'Workflow';
  return (
    workflowPath
      .split('/')
      .pop()
      ?.replace(/\.(yml|yaml)$/i, '') || 'Workflow'
  );
}

function normalizeStatus(status?: string): WorkflowStatus {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
    case 'failure':
      return 'failure';
    case 'running':
      return 'running';
    case 'queued':
      return 'queued';
    case 'in_progress':
      return 'in_progress';
    case 'cancelled':
      return 'cancelled';
    case 'pending':
      return 'pending';
    case 'skipped':
      return 'skipped';
    default:
      return status ? 'unknown' : 'pending';
  }
}

function resolveRunStatus(
  workflowLogEvent?: NostrEvent,
  loomStatusEvent?: NostrEvent,
  loomResultEvent?: NostrEvent
): { status: WorkflowStatus; duration?: number } {
  if (workflowLogEvent) {
    const status = normalizeStatus(tagValue(workflowLogEvent, 'status'));
    const duration = Number.parseInt(tagValue(workflowLogEvent, 'duration') || '', 10);

    return {
      status,
      duration: Number.isFinite(duration) ? duration : undefined,
    };
  }

  if (loomResultEvent) {
    const success = tagValue(loomResultEvent, 'success');
    const exitCode = tagValue(loomResultEvent, 'exit_code');
    return {
      status: success === 'true' || exitCode === '0' ? 'success' : 'failure',
    };
  }

  if (loomStatusEvent) {
    return {
      status: normalizeStatus(tagValue(loomStatusEvent, 'status')),
    };
  }

  return { status: 'pending' };
}

function parseLegacyJobEvent(event: NostrEvent): WorkflowRun {
  const argsTag = event.tags.find((tag) => tag[0] === 'args');
  const args = argsTag ? argsTag.slice(1) : [];

  let workflowPath = '';
  if (args.length >= 2 && args[0] === '-c') {
    const bashCommand = args[1];
    const match =
      typeof bashCommand === 'string' ? bashCommand.match(/act -W (\S+\.(?:yml|yaml))/) : null;
    workflowPath = match?.[1] || '';
  }

  return {
    id: event.id,
    name: workflowNameFromPath(workflowPath),
    workflowPath,
    status: 'pending',
    branch: tagValue(event, 'branch') || 'main',
    commit: event.id.slice(0, 7),
    commitMessage: `Workflow run: ${workflowNameFromPath(workflowPath)}`,
    actor: event.pubkey.slice(0, 12),
    event: 'manual',
    createdAt: event.created_at * 1000,
    updatedAt: event.created_at * 1000,
    workerPubkey: tagValue(event, 'p'),
    loomJobEvent: event,
  };
}

function parseWorkflowRunEvent(event: NostrEvent): WorkflowRun {
  const workflowPath = tagValue(event, 'workflow') || '';
  const trigger = tagValue(event, 'trigger') || 'manual';
  const actor = tagValue(event, 'triggered-by') || event.pubkey;
  const branch = tagValue(event, 'branch') || 'main';
  const commit = tagValue(event, 'commit') || '';

  return {
    id: event.id,
    name: workflowNameFromPath(workflowPath),
    workflowPath,
    status: 'pending',
    branch,
    commit,
    commitMessage: `Workflow run: ${workflowNameFromPath(workflowPath)}`,
    actor,
    event: trigger,
    createdAt: event.created_at * 1000,
    updatedAt: event.created_at * 1000,
    runEvent: event,
  };
}

export async function queryEvents(
  bridge: BridgeLike,
  relays: string[],
  filters: Array<Record<string, unknown>>
): Promise<NostrEvent[]> {
  const response = await bridge.request('nostr:query', {
    filters,
    relays: relays.length > 0 ? relays : FALLBACK_RELAYS,
  });

  if (response && typeof response === 'object' && 'error' in response) {
    throw new Error(String((response as { error?: string }).error || 'Unknown Nostr query error'));
  }

  if (
    response &&
    typeof response === 'object' &&
    'status' in response &&
    (response as { status?: string }).status === 'ok' &&
    Array.isArray((response as { events?: unknown[] }).events)
  ) {
    return (response as unknown as { events: NostrEvent[] }).events;
  }

  return [];
}

export async function loadWorkflowRuns(
  bridge: BridgeLike,
  repo: RepoContextNormalized
): Promise<WorkflowRun[]> {
  const relays = dedupe([...repo.repoRelays, ...FALLBACK_RELAYS]);

  if (!repo.repoNaddr) return [];

  const runEvents = await queryEvents(bridge, relays, [
    {
      kinds: [5401],
      '#a': [repo.repoNaddr],
      limit: 100,
    },
  ]);

  if (runEvents.length === 0) {
    const legacyJobEvents = await queryEvents(bridge, relays, [
      {
        kinds: [5100],
        '#a': [repo.repoNaddr],
        limit: 50,
      },
    ]);

    return legacyJobEvents.map(parseLegacyJobEvent).sort((a, b) => b.createdAt - a.createdAt);
  }

  const runIds = runEvents.map((event) => event.id);
  const [workflowLogEvents, loomJobEvents, topLevelStatusEvents, topLevelResultEvents] =
    await Promise.all([
      queryEvents(bridge, relays, [{ kinds: [5402], '#e': runIds, limit: 200 }]),
      queryEvents(bridge, relays, [{ kinds: [5100], '#e': runIds, limit: 200 }]),
      queryEvents(bridge, relays, [{ kinds: [30100], '#e': runIds, limit: 200 }]),
      queryEvents(bridge, relays, [{ kinds: [5101], '#e': runIds, limit: 200 }]),
    ]);

  const loomJobIds = loomJobEvents.map((event) => event.id);
  const [loomStatusEvents, loomResultEvents] = loomJobIds.length
    ? await Promise.all([
        queryEvents(bridge, relays, [{ kinds: [30100], '#e': loomJobIds, limit: 200 }]),
        queryEvents(bridge, relays, [{ kinds: [5101], '#e': loomJobIds, limit: 200 }]),
      ])
    : [[], []];

  const allStatusEvents = [...topLevelStatusEvents, ...loomStatusEvents];
  const allResultEvents = [...topLevelResultEvents, ...loomResultEvents];

  const loomJobByRunId = new Map<string, NostrEvent>();
  for (const event of loomJobEvents) {
    const runId = tagValue(event, 'e');
    if (runId) loomJobByRunId.set(runId, event);
  }

  return runEvents
    .map((event) => {
      const runId = event.id;
      const loomJobEvent = loomJobByRunId.get(runId);
      const loomJobId = loomJobEvent?.id;

      const workflowLogEvent = workflowLogEvents.find(
        (candidate) => tagValue(candidate, 'e') === runId
      );
      const loomStatusEvent = [...allStatusEvents]
        .filter((candidate) => {
          const target = tagValue(candidate, 'e');
          return target === runId || (loomJobId && target === loomJobId);
        })
        .sort((a, b) => b.created_at - a.created_at)[0];

      const loomResultEvent = [...allResultEvents]
        .filter((candidate) => {
          const target = tagValue(candidate, 'e');
          return target === runId || (loomJobId && target === loomJobId);
        })
        .sort((a, b) => b.created_at - a.created_at)[0];

      const parsed = parseWorkflowRunEvent(event);
      const resolved = resolveRunStatus(workflowLogEvent, loomStatusEvent, loomResultEvent);

      return {
        ...parsed,
        ...resolved,
        workerPubkey: tagValue(loomJobEvent, 'p'),
        workflowLogEvent,
        loomJobEvent,
        loomStatusEvent,
        loomResultEvent,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function loadWorkflowRunDetail(
  bridge: BridgeLike,
  repo: RepoContextNormalized,
  runId: string
): Promise<WorkflowRunDetail | null> {
  const relays = dedupe([...repo.repoRelays, ...FALLBACK_RELAYS]);
  const [runEvents, workflowLogEvents, loomJobEvents, topLevelResultEvents, topLevelStatusEvents] =
    await Promise.all([
      queryEvents(bridge, relays, [{ kinds: [5401], ids: [runId], limit: 1 }]),
      queryEvents(bridge, relays, [{ kinds: [5402], '#e': [runId], limit: 20 }]),
      queryEvents(bridge, relays, [
        { kinds: [5100], '#e': [runId], limit: 20 },
        { kinds: [5100], ids: [runId], limit: 1 },
      ]),
      queryEvents(bridge, relays, [{ kinds: [5101], '#e': [runId], limit: 20 }]),
      queryEvents(bridge, relays, [{ kinds: [30100], '#e': [runId], limit: 20 }]),
    ]);

  const runEvent = runEvents[0];
  const loomJobEvent = loomJobEvents.sort((a, b) => b.created_at - a.created_at)[0];
  const loomJobId = loomJobEvent?.id;

  const [childResultEvents, childStatusEvents] = loomJobId
    ? await Promise.all([
        queryEvents(bridge, relays, [{ kinds: [5101], '#e': [loomJobId], limit: 20 }]),
        queryEvents(bridge, relays, [{ kinds: [30100], '#e': [loomJobId], limit: 20 }]),
      ])
    : [[], []];

  const workflowLogEvent = workflowLogEvents.sort((a, b) => b.created_at - a.created_at)[0];
  const loomResultEvent = [...topLevelResultEvents, ...childResultEvents].sort(
    (a, b) => b.created_at - a.created_at
  )[0];
  const loomStatusEvent = [...topLevelStatusEvents, ...childStatusEvents].sort(
    (a, b) => b.created_at - a.created_at
  )[0];

  if (!runEvent && !loomJobEvent) return null;

  const baseRun = runEvent ? parseWorkflowRunEvent(runEvent) : parseLegacyJobEvent(loomJobEvent!);
  const resolved = resolveRunStatus(workflowLogEvent, loomStatusEvent, loomResultEvent);

  const run: WorkflowRun = {
    ...baseRun,
    ...resolved,
    workflowLogEvent,
    loomJobEvent,
    loomStatusEvent,
    loomResultEvent,
    workerPubkey: tagValue(loomJobEvent, 'p'),
  };

  const workerPubkey = run.workerPubkey;
  let worker: LoomWorker | null = null;

  if (workerPubkey) {
    const workerEvents = await queryEvents(bridge, relays, [
      { kinds: [10100], authors: [workerPubkey], limit: 10 },
    ]);
    worker =
      workerEvents
        .sort((a, b) => b.created_at - a.created_at)
        .map(parseLoomWorker)
        .find((candidate): candidate is LoomWorker => candidate !== null) || null;
  }

  return { run, worker };
}

export function parseLoomWorker(event: NostrEvent): LoomWorker | null {
  try {
    const content = JSON.parse(event.content || '{}');
    if (!content?.name) return null;

    const softwareTags = event.tags.filter((tag) => tag[0] === 'S');
    const actSoftware = softwareTags.find((tag) => tag[1] === 'act');
    const priceTags = event.tags.filter((tag) => tag[0] === 'price');

    return {
      pubkey: event.pubkey,
      name: content.name,
      description: content.description || '',
      architecture: tagValue(event, 'A'),
      actVersion: actSoftware?.[2],
      pricing:
        priceTags.length > 0
          ? {
              perSecondRate: Number.parseFloat(priceTags[0]?.[2] || ''),
              unit: priceTags[0]?.[3],
            }
          : undefined,
      mints: priceTags
        .map((tag) => tag[4])
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
      minDuration: Number.parseInt(tagValue(event, 'min_duration') || '', 10) || undefined,
      maxDuration: Number.parseInt(tagValue(event, 'max_duration') || '', 10) || undefined,
      maxConcurrentJobs:
        Number.parseInt(String(content.max_concurrent_jobs || ''), 10) || undefined,
      currentQueueDepth:
        Number.parseInt(String(content.current_queue_depth || ''), 10) || undefined,
      online: Date.now() - event.created_at * 1000 < 5 * 60 * 1000,
      lastSeen: event.created_at,
    };
  } catch {
    return null;
  }
}

export async function loadWorkers(
  bridge: BridgeLike,
  repo: RepoContextNormalized
): Promise<LoomWorker[]> {
  const relays = dedupe([...repo.repoRelays, ...FALLBACK_RELAYS]);
  const workerEvents = await queryEvents(bridge, relays, [{ kinds: [10100], limit: 200 }]);

  const latestByPubkey = new Map<string, NostrEvent>();
  for (const event of workerEvents) {
    const existing = latestByPubkey.get(event.pubkey);
    if (!existing || event.created_at > existing.created_at) {
      latestByPubkey.set(event.pubkey, event);
    }
  }

  return Array.from(latestByPubkey.values())
    .map(parseLoomWorker)
    .filter((worker): worker is LoomWorker => worker !== null)
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (a.currentQueueDepth || 0) - (b.currentQueueDepth || 0);
    });
}

export function statusLabel(status: WorkflowStatus): string {
  switch (status) {
    case 'in_progress':
      return 'In progress';
    default:
      return status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' ');
  }
}

export function publicLinkForRun(runId: string): string {
  return `nostr:${runId}`;
}

export function externalUrlForEvent(event: NostrEvent | undefined): string | undefined {
  return (
    tagValue(event, 'log_url') || tagValue(event, 'url') || tagValue(event, 'stdout') || undefined
  );
}

export function eventSummary(event: NostrEvent | undefined): string {
  if (!event) return '—';
  const notableTags = ['status', 'exit_code', 'workflow', 'branch', 'commit', 'trigger'];

  const bits = notableTags
    .map((name) => {
      const value = tagValue(event, name);
      return value ? `${name}: ${value}` : null;
    })
    .filter(Boolean);

  if (bits.length > 0) return bits.join(' • ');
  return `${event.kind} event`;
}

export function eventERefs(event: NostrEvent | undefined): string[] {
  return tagValues(event, 'e');
}

export function buildRerunDraft(
  repo: RepoContextNormalized,
  detail: WorkflowRunDetail | null
): RerunDraft | null {
  const loomJobEvent = detail?.run.loomJobEvent;
  if (!repo.repoNaddr || !loomJobEvent) return null;

  const command = tagValue(loomJobEvent, 'cmd');
  const argsTag = loomJobEvent.tags.find((tag) => tag[0] === 'args');
  const workerPubkey = tagValue(loomJobEvent, 'p');

  if (!command || !argsTag || !workerPubkey) return null;

  const envVars = loomJobEvent.tags
    .filter((tag) => tag[0] === 'env' && typeof tag[1] === 'string' && typeof tag[2] === 'string')
    .filter(
      (tag): tag is [string, string, string, ...string[]] =>
        typeof tag[1] === 'string' && typeof tag[2] === 'string' && !tag[1].startsWith('HIVE_CI_')
    )
    .map((tag) => ({ key: tag[1], value: tag[2] }));

  const publishRelays = dedupe([...repo.repoRelays, ...FALLBACK_RELAYS]);

  return {
    repoNaddr: repo.repoNaddr,
    workflowPath: detail?.run.workflowPath || tagValue(detail?.run.runEvent, 'workflow') || '',
    branch: detail?.run.branch || tagValue(detail?.run.runEvent, 'branch') || 'main',
    commit: detail?.run.commit || tagValue(detail?.run.runEvent, 'commit') || '',
    workerPubkey,
    command,
    args: argsTag.slice(1),
    envVars,
    repoNostrUrl: toRepoNostrUrl(repo.repoNaddr, publishRelays),
    publishRelays,
  };
}
