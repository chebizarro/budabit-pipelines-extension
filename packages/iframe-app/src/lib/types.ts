import type { WidgetBridge } from '@flotilla/ext-shared';

export interface RepoContext {
  contextId?: string;
  userPubkey?: string;
  relays?: string[];
  repo?: {
    repoPubkey: string;
    repoName: string;
    repoNaddr?: string;
    repoRelays: string[];
    maintainers?: string[];
  };
}

export interface RepoContextNormalized {
  contextId?: string;
  userPubkey?: string;
  repoPubkey: string;
  repoName: string;
  repoNaddr?: string;
  repoRelays: string[];
  maintainers?: string[];
}

export interface NostrEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig?: string;
}

export type WorkflowStatus =
  | 'success'
  | 'failure'
  | 'running'
  | 'queued'
  | 'in_progress'
  | 'cancelled'
  | 'pending'
  | 'skipped'
  | 'unknown';

export interface WorkflowRun {
  id: string;
  name: string;
  workflowPath?: string;
  status: WorkflowStatus;
  branch: string;
  commit: string;
  commitMessage: string;
  actor: string;
  event: string;
  createdAt: number;
  updatedAt: number;
  duration?: number;
  workerPubkey?: string;
  workerName?: string;
  runEvent?: NostrEvent;
  workflowLogEvent?: NostrEvent;
  loomJobEvent?: NostrEvent;
  loomStatusEvent?: NostrEvent;
  loomResultEvent?: NostrEvent;
}

export interface LoomWorker {
  pubkey: string;
  name: string;
  description: string;
  architecture?: string;
  actVersion?: string;
  pricing?: {
    baseFee?: number;
    perSecondRate?: number;
    unit?: string;
  };
  mints: string[];
  minDuration?: number;
  maxDuration?: number;
  maxConcurrentJobs?: number;
  currentQueueDepth?: number;
  online: boolean;
  lastSeen: number;
}

export interface WorkflowRunDetail {
  run: WorkflowRun;
  worker?: LoomWorker | null;
}

export interface RerunDraft {
  repoNaddr: string;
  workflowPath: string;
  branch: string;
  commit: string;
  workerPubkey: string;
  command: string;
  args: string[];
  envVars: Array<{ key: string; value: string }>;
  repoNostrUrl: string;
  publishRelays: string[];
}

export type BridgeLike = WidgetBridge;
