import {EventStore} from 'applesauce-core';
import {RelayPool, onlyEvents} from 'applesauce-relay';
import {
  EMPTY,
  combineLatest,
  distinctUntilChanged,
  filter,
  map,
  merge,
  scan,
  shareReplay,
  switchMap,
  type Observable,
} from 'rxjs';
import type {NostrEvent} from './types';

/**
 * Shared nostr primitives for the widget.
 *
 * Phase 1: in-memory EventStore. Phase 1b will swap in a Turso-WASM
 * persistent database so cold loads are instant across sessions.
 */

export const eventStore = new EventStore();
export const pool = new RelayPool();

/** Hive CI event kinds. */
export const KIND_WORKFLOW_RUN = 5401;
export const KIND_WORKFLOW_RESULT = 5402;
export const KIND_LOOM_JOB = 5100;
export const KIND_LOOM_RESULT = 5101;
export const KIND_LOOM_STATUS = 30100;
export const KIND_LOOM_WORKER = 10100;

function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find(t => t[0] === name)?.[1];
}

function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Merged event stream for a repo's pipelines view.
 *
 * Layered so untrusted identities can't spam us with bogus status/result
 * events — every secondary subscription is keyed on pubkeys or ids that
 * have already appeared in a trust-gated primary event.
 *
 * - **Primary** (layer 1): workflow runs + loom jobs authored by maintainers
 *   (tagged with the repo's `#a`).
 * - **Worker events** (layer 2): loom status/result/worker-profile events
 *   authored by any worker pubkey observed as the `p` tag on a layer-1 loom
 *   job — scoped to the known job ids.
 * - **Workflow results** (layer 3): kind-5402 events authored by any pubkey
 *   observed as the `publisher` tag on a layer-1 workflow run — scoped to
 *   the known run ids.
 */
export function repoEvents(
  repoAddress: string,
  relays: string[],
  trustedAuthors: string[],
): Observable<NostrEvent> {
  const authors = [...new Set(trustedAuthors)];
  if (authors.length === 0) return EMPTY;

  const primary$ = pool
    .subscription(relays, {
      kinds: [KIND_WORKFLOW_RUN, KIND_LOOM_JOB],
      '#a': [repoAddress],
      authors,
    })
    .pipe(onlyEvents(), shareReplay({bufferSize: Infinity, refCount: true}));

  const accumulateToSet = <T>(values$: Observable<T>) =>
    values$.pipe(
      scan((set, v) => (set.has(v) ? set : new Set(set).add(v)), new Set<T>()),
      distinctUntilChanged(setsEqual),
    );

  const workers$ = accumulateToSet(
    primary$.pipe(
      filter(e => e.kind === KIND_LOOM_JOB),
      map(e => tagValue(e, 'p')),
      filter((pk): pk is string => !!pk),
    ),
  );

  const jobIds$ = accumulateToSet(
    primary$.pipe(
      filter(e => e.kind === KIND_LOOM_JOB),
      map(e => e.id),
    ),
  );

  const publishers$ = accumulateToSet(
    primary$.pipe(
      filter(e => e.kind === KIND_WORKFLOW_RUN),
      map(e => tagValue(e, 'publisher')),
      filter((pk): pk is string => !!pk),
    ),
  );

  const runIds$ = accumulateToSet(
    primary$.pipe(
      filter(e => e.kind === KIND_WORKFLOW_RUN),
      map(e => e.id),
    ),
  );

  const workerEvents$ = combineLatest([workers$, jobIds$]).pipe(
    switchMap(([workers, jobIds]) => {
      if (!workers.size || !jobIds.size) return EMPTY;
      return pool
        .subscription(relays, {
          kinds: [KIND_LOOM_RESULT, KIND_LOOM_STATUS],
          authors: [...workers],
          '#e': [...jobIds],
        })
        .pipe(onlyEvents());
    }),
  );

  const workerInfo$ = workers$.pipe(
    switchMap(workers => {
      if (!workers.size) return EMPTY;
      return pool
        .subscription(relays, {
          kinds: [KIND_LOOM_WORKER],
          authors: [...workers],
        })
        .pipe(onlyEvents());
    }),
  );

  const workflowResults$ = combineLatest([publishers$, runIds$]).pipe(
    switchMap(([publishers, runIds]) => {
      if (!publishers.size || !runIds.size) return EMPTY;
      return pool
        .subscription(relays, {
          kinds: [KIND_WORKFLOW_RESULT],
          authors: [...publishers],
          '#e': [...runIds],
        })
        .pipe(onlyEvents());
    }),
  );

  return merge(primary$, workerEvents$, workerInfo$, workflowResults$);
}
