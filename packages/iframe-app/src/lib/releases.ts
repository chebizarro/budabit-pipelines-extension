import type { WidgetBridge } from '@flotilla/ext-shared';
import type { NostrEvent, RepoContextNormalized } from './types';
import { queryEvents, eventTagValue } from './pipelines';

const FALLBACK_RELAYS = ['wss://relay.sharegap.net', 'wss://nos.lol'];

function dedupe(values: string[]): string[] {
  return Array.from(
    new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))
  );
}

// ── Types ─────────────────────────────────────────────────────────────

export interface ReleaseArtifact {
  event: NostrEvent;
  hash: string;
  filename: string;
  triggeredBy: string;
  ephemeralPubkey: string;
  workflow: string;
  branch: string;
  tags: Record<string, string>;
}

export interface ArtifactGroup {
  key: string;
  labels: Record<string, string>;
  hashCounts: Map<string, ReleaseArtifact[]>;
  totalCount: number;
  consensusHash: string | null;
  isUnanimous: boolean;
}

export interface LoomWorkerInfo {
  pubkey: string;
  name: string;
}

export type ConsensusStatus = 'unanimous' | 'majority' | 'split';

// ── Validation ────────────────────────────────────────────────────────

export function validateHash(hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash);
}

// ── Grouping & Consensus ──────────────────────────────────────────────

export function buildGroupKey(event: NostrEvent, groupByTags: string[]): string {
  return groupByTags.map((tag) => eventTagValue(event, tag) ?? 'unknown').join('|');
}

export function groupArtifacts(
  artifacts: ReleaseArtifact[],
  groupByTags: string[]
): ArtifactGroup[] {
  const groups = new Map<string, ReleaseArtifact[]>();

  for (const artifact of artifacts) {
    const key = buildGroupKey(artifact.event, groupByTags);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(artifact);
  }

  return Array.from(groups.entries()).map(([key, arts]) => {
    const hashCounts = new Map<string, ReleaseArtifact[]>();
    for (const a of arts) {
      if (!hashCounts.has(a.hash)) hashCounts.set(a.hash, []);
      hashCounts.get(a.hash)!.push(a);
    }

    const sorted = [...hashCounts.entries()].sort((a, b) => b[1].length - a[1].length);
    const consensusHash = sorted[0]?.[0] ?? null;
    const isUnanimous = sorted.length === 1;

    return {
      key,
      labels: Object.fromEntries(
        groupByTags.map((tag) => [tag, arts[0] ? (eventTagValue(arts[0].event, tag) ?? 'unknown') : 'unknown'])
      ),
      hashCounts,
      totalCount: arts.length,
      consensusHash,
      isUnanimous,
    };
  });
}

export function getConsensusStatus(group: ArtifactGroup): ConsensusStatus {
  if (group.isUnanimous) return 'unanimous';
  if (!group.consensusHash) return 'split';
  const top = group.hashCounts.get(group.consensusHash)?.length ?? 0;
  if (top / group.totalCount > 0.5) return 'majority';
  return 'split';
}

// ── Event Construction ────────────────────────────────────────────────

/**
 * Build an unsigned kind 1063 event that copies tags from the source artifact.
 * The host signer will add pubkey/id/sig when signing via nostr:sign.
 */
export function createSignedReleaseTemplate(sourceEvent: NostrEvent): {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
} {
  const tags = sourceEvent.tags.filter((t) => t[0] !== 'url');
  const urlTag = sourceEvent.tags.find((t) => t[0] === 'url');
  if (urlTag) tags.unshift(urlTag);

  return {
    kind: sourceEvent.kind,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: sourceEvent.content,
  };
}

// ── Data Loading ──────────────────────────────────────────────────────

/**
 * Load release artifacts via the host bridge.
 *
 * Two-phase approach:
 * 1. Fetch kind 5401 workflow runs → extract trusted ephemeral publisher keys
 * 2. Fetch kind 1063 (NIP-94 file metadata) from those keys, plus e-tag linked artifacts
 *
 * Returns all the data needed to render the release signing view.
 */
export async function loadReleaseData(
  bridge: WidgetBridge,
  repo: RepoContextNormalized,
  trustedMaintainers: string[],
  filterKinds: number[] = [1063]
): Promise<{
  artifacts: ReleaseArtifact[];
  workflowRuns: Map<string, NostrEvent>;
  workerNames: Map<string, string>;
  ephemeralToWorker: Map<string, string>;
}> {
  const relays = dedupe([...repo.repoRelays, ...FALLBACK_RELAYS]);
  const trustedNpubs = new Set(trustedMaintainers);

  const emptyResult = {
    artifacts: [],
    workflowRuns: new Map<string, NostrEvent>(),
    workerNames: new Map<string, string>(),
    ephemeralToWorker: new Map<string, string>(),
  };

  if (!repo.repoNaddr || trustedNpubs.size === 0) {
    console.log('[releases] no repoNaddr or no trusted maintainers');
    return emptyResult;
  }

  // Phase 1: Load workflow runs (kind 5401) to discover ephemeral pubkeys
  const runs = await queryEvents(bridge, relays, [
    { kinds: [5401], '#a': [repo.repoNaddr] },
  ]);

  console.log('[releases] Found', runs.length, 'workflow runs');

  // Build two indexes from trusted runs
  const publisherMap = new Map<string, NostrEvent>();
  const runIdMap = new Map<string, NostrEvent>();

  for (const run of runs) {
    const triggeredBy = eventTagValue(run, 'triggered-by');
    const publisher = eventTagValue(run, 'publisher');
    if (triggeredBy && trustedNpubs.has(triggeredBy)) {
      if (publisher) publisherMap.set(publisher, run);
      runIdMap.set(run.id, run);
    }
  }

  const publishers = Array.from(publisherMap.keys());
  const runIds = Array.from(runIdMap.keys());

  if (publishers.length === 0 && runIds.length === 0) {
    return emptyResult;
  }

  // Phase 2: Fetch artifacts via both trust paths, deduplicate
  const filters: Array<Record<string, unknown>> = [];
  if (publishers.length > 0) {
    filters.push({ kinds: filterKinds, authors: publishers });
  }
  if (runIds.length > 0) {
    filters.push({ kinds: filterKinds, '#e': runIds });
  }

  const allEvents = await queryEvents(bridge, relays, filters);

  // For e-tag-linked events, backfill publisherMap
  for (const e of allEvents) {
    if (!publisherMap.has(e.pubkey)) {
      const eTag = e.tags.find((t) => t[0] === 'e')?.[1];
      if (eTag && runIdMap.has(eTag)) {
        publisherMap.set(e.pubkey, runIdMap.get(eTag)!);
      }
    }
  }

  // Filter to valid artifacts
  const releaseEvents = allEvents.filter((e) => {
    const hash = eventTagValue(e, 'x');
    return hash && validateHash(hash);
  });

  // Build artifacts
  const artifacts: ReleaseArtifact[] = releaseEvents
    .map((event) => {
      const hash = eventTagValue(event, 'x');
      if (!hash) return null;
      const publisherRun = publisherMap.get(event.pubkey);
      if (!publisherRun) return null;

      return {
        event,
        hash,
        filename: eventTagValue(event, 'filename') ?? 'unknown',
        triggeredBy: eventTagValue(publisherRun, 'triggered-by') ?? '',
        ephemeralPubkey: event.pubkey,
        workflow: eventTagValue(publisherRun, 'workflow') ?? '',
        branch: eventTagValue(publisherRun, 'branch') ?? '',
        tags: Object.fromEntries(event.tags.map((t) => [t[0], t[1]])),
      };
    })
    .filter((a): a is ReleaseArtifact => a !== null);

  // Phase 3: Resolve worker names via Kind 5100 → Kind 10100
  const ephemeralToWorker = new Map<string, string>();
  const workerNames = new Map<string, string>();

  if (runIds.length > 0) {
    const jobEvents = await queryEvents(bridge, relays, [
      { kinds: [5100], '#e': runIds, limit: 200 },
    ]);

    for (const job of jobEvents) {
      const eTag = job.tags.find((t) => t[0] === 'e')?.[1];
      const pTag = job.tags.find((t) => t[0] === 'p')?.[1];
      if (eTag && pTag && runIdMap.has(eTag)) {
        const run = runIdMap.get(eTag)!;
        const publisher = eventTagValue(run, 'publisher');
        if (publisher) ephemeralToWorker.set(publisher, pTag);
      }
    }

    const workerPubkeys = [...new Set(ephemeralToWorker.values())];
    if (workerPubkeys.length > 0) {
      const ads = await queryEvents(bridge, relays, [
        { kinds: [10100], authors: workerPubkeys, limit: 200 },
      ]);

      const adByPubkey = new Map<string, NostrEvent>();
      for (const ad of ads) {
        const existing = adByPubkey.get(ad.pubkey);
        if (!existing || ad.created_at > existing.created_at) {
          adByPubkey.set(ad.pubkey, ad);
        }
      }

      for (const [ephKey, workerPk] of ephemeralToWorker) {
        const ad = adByPubkey.get(workerPk);
        if (ad) {
          try {
            const content = JSON.parse(ad.content || '{}');
            if (content.name) workerNames.set(ephKey, content.name);
          } catch {
            // ignore
          }
        }
      }
    }
  }

  return { artifacts, workflowRuns: publisherMap, workerNames, ephemeralToWorker };
}

/**
 * Sign an event via the host bridge's nostr:sign handler.
 * Returns the full signed event.
 */
export async function signEvent(
  bridge: WidgetBridge,
  unsignedEvent: Record<string, unknown>
): Promise<NostrEvent> {
  const res: any = await bridge.request('nostr:sign', unsignedEvent);

  if (res?.error) {
    throw new Error(`Sign failed: ${res.error}`);
  }

  // The host returns the signed event
  const signed = res?.event ?? res;
  if (!signed?.id || !signed?.sig) {
    throw new Error('Host did not return a signed event');
  }

  return signed as NostrEvent;
}

/**
 * Sign and publish release attestations for the selected artifacts.
 */
export async function signAndPublishReleases(
  bridge: WidgetBridge,
  repo: RepoContextNormalized,
  artifacts: ReleaseArtifact[],
  publishRelays?: string[]
): Promise<number> {
  const relays = publishRelays ?? dedupe([...repo.repoRelays, ...FALLBACK_RELAYS]);
  let signedCount = 0;

  for (const artifact of artifacts) {
    const unsigned = createSignedReleaseTemplate(artifact.event);

    // Sign via host bridge
    const signed = await signEvent(bridge, unsigned);

    // Publish the signed event
    const publishRes: any = await bridge.request('nostr:publish', {
      event: signed,
      relays,
    });

    if (publishRes?.error) {
      console.error('[releases] publish failed:', publishRes.error);
    } else {
      signedCount++;
    }
  }

  return signedCount;
}

/**
 * Resolve a NIP-51 people list to an array of pubkeys.
 */
export async function resolveNip51List(
  bridge: WidgetBridge,
  listAddr: string,
  relays: string[]
): Promise<string[]> {
  const events = await queryEvents(bridge, relays, [
    { kinds: [30000], '#d': [listAddr] },
  ]);

  if (events.length === 0) return [];

  const first = events[0];
  if (!first) return [];

  return first.tags
    .filter((t) => t[0] === 'p')
    .map((t) => t[1])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
}
