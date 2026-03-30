import { formatDistanceToNow } from 'date-fns'
import { Check, Circle, Clock, RotateCw, X } from '@lucide/svelte'
import type { LoomWorker, RepoContextNormalized, WorkflowStatus, RerunDraft } from './types'

export function getStatusIcon(status: WorkflowStatus) {
  switch (status) {
    case 'success':
      return Check
    case 'failure':
      return X
    case 'running':
    case 'in_progress':
      return RotateCw
    case 'queued':
    case 'pending':
      return Clock
    case 'cancelled':
    case 'skipped':
    case 'unknown':
    default:
      return Circle
  }
}

export function getStatusColor(status: WorkflowStatus) {
  switch (status) {
    case 'success':
      return 'text-green-400'
    case 'failure':
      return 'text-red-400'
    case 'running':
    case 'in_progress':
      return 'text-yellow-400'
    case 'queued':
      return 'text-sky-400'
    case 'pending':
      return 'text-zinc-400'
    default:
      return 'text-zinc-400'
  }
}

export function getStatusBadge(status: WorkflowStatus) {
  switch (status) {
    case 'success':
      return 'border-green-500/20 bg-green-500/10 text-green-300'
    case 'failure':
      return 'border-red-500/20 bg-red-500/10 text-red-300'
    case 'running':
    case 'in_progress':
      return 'border-yellow-500/20 bg-yellow-500/10 text-yellow-300'
    case 'queued':
      return 'border-sky-500/20 bg-sky-500/10 text-sky-300'
    case 'pending':
      return 'border-zinc-500/20 bg-zinc-500/10 text-zinc-300'
    default:
      return 'border-zinc-500/20 bg-zinc-500/10 text-zinc-300'
  }
}

export function formatTimeAgo(timestamp: number) {
  return formatDistanceToNow(timestamp, {addSuffix: true})
}

export function formatDuration(seconds?: number) {
  if (!seconds) return '—'
  if (seconds < 60) return `${seconds}s`

  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
}

export function shortId(value?: string, size = 8) {
  return value ? value.slice(0, size) : '—'
}

export function repoName(value: RepoContextNormalized | null) {
  return value?.repoName || 'Loading repository…'
}

export function suggestedPaymentAmount(worker: LoomWorker | null) {
  if (!worker?.pricing?.perSecondRate || !worker.minDuration) return 100
  return Math.max(1, Math.ceil(worker.pricing.perSecondRate * worker.minDuration))
}

export function buildAutoTokenCandidateKey(args: {
  draft: RerunDraft | null
  selectedWorker: LoomWorker | null
  selectedMint: string
  canGenerateSuggestedToken: boolean
  rerunPaymentToken: string
  submissionMode: 'new' | 'rerun' | null
  paymentAmount: number
}) {
  const {
    draft,
    selectedWorker,
    selectedMint,
    canGenerateSuggestedToken,
    rerunPaymentToken,
    submissionMode,
    paymentAmount,
  } = args

  if (!draft || !selectedWorker || !selectedMint || !canGenerateSuggestedToken || rerunPaymentToken.trim()) {
    return ''
  }

  return [
    submissionMode || 'draft',
    selectedWorker.pubkey,
    selectedMint,
    paymentAmount,
    draft.workflowPath,
    draft.branch,
    draft.commit,
  ].join(':')
}
