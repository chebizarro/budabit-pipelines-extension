<script lang="ts">
  import {Copy, ExternalLink, GitBranch, GitCommit, Server} from '@lucide/svelte'
  import {shortId} from '../presentation'
  import {publicLinkForRun} from '../workflows'
  import type {WorkflowRun, LoomWorker} from '../types'

  interface Props {
    run: WorkflowRun
    worker: LoomWorker | null | undefined
    prepaidAmount: number | null
    changeAmount: number | null
    actualCost: number | null
    copyText: (value: string | undefined, label: string) => void | Promise<void>
  }

  const {run, worker, prepaidAmount, changeAmount, actualCost, copyText}: Props = $props()
</script>

<aside class="min-w-0">
  <div class="divide-y divide-border rounded-lg border border-border bg-card p-3 text-sm">
    <section class="space-y-2 pb-3">
      <div class="flex items-center gap-2">
        <GitBranch class="h-4 w-4 text-muted-foreground" />
        <span class="font-medium">{run.branch || '—'}</span>
      </div>
      {#if run.commit}
        <div class="flex items-center gap-2 text-xs">
          <GitCommit class="h-3.5 w-3.5 text-muted-foreground" />
          <code class="min-w-0 flex-1 truncate font-mono">{shortId(run.commit, 7)}</code>
          <button
            class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Copy commit"
            onclick={() => void copyText(run.commit, 'Commit')}>
            <Copy class="h-3 w-3" />
          </button>
        </div>
      {/if}
      <div class="flex items-center gap-2 text-xs">
        <span class="text-muted-foreground">Run</span>
        <code class="min-w-0 flex-1 truncate font-mono">{shortId(run.id, 7)}</code>
        <button
          class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Copy run ID"
          onclick={() => void copyText(run.id, 'Run ID')}>
          <Copy class="h-3 w-3" />
        </button>
        <a
          class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          title="Open event"
          href={publicLinkForRun(run.id)}
          target="_blank"
          rel="noreferrer">
          <ExternalLink class="h-3 w-3" />
        </a>
      </div>
      {#if run.workflowPath}
        <div class="truncate text-xs text-muted-foreground" title={run.workflowPath}>
          {run.workflowPath.split('/').pop() || run.workflowPath}
        </div>
      {/if}
    </section>

    <section class="space-y-2 py-3">
      <div class="text-xs font-semibold text-muted-foreground">Cost</div>
      <div class="flex items-center justify-between text-xs">
        <span class="text-muted-foreground">Prepaid</span>
        <span class="font-mono">{prepaidAmount !== null ? `${prepaidAmount.toLocaleString()} sats` : '—'}</span>
      </div>
      <div class="flex items-center justify-between text-xs">
        <span class="text-muted-foreground">Change</span>
        <span class="font-mono">{changeAmount !== null ? `${changeAmount.toLocaleString()} sats` : '—'}</span>
      </div>
      <div class="flex items-center justify-between border-t border-border pt-2 text-sm">
        <span class="font-medium">Actual cost</span>
        <span class="font-mono font-semibold">{actualCost !== null ? `${actualCost.toLocaleString()} sats` : '—'}</span>
      </div>
    </section>

    {#if worker}
      <section class="space-y-2 pt-3">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
            <Server class="h-3.5 w-3.5" />
            Worker
          </div>
          <span class={`text-xs ${worker.online ? 'text-green-400' : 'text-muted-foreground'}`}>
            {worker.online ? 'online' : 'offline'}
          </span>
        </div>
        <div class="text-sm font-medium">{worker.name}</div>
        <div class="flex items-center gap-1 text-xs">
          <code class="min-w-0 flex-1 truncate font-mono text-muted-foreground">{shortId(worker.pubkey, 12)}</code>
          <button
            class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Copy pubkey"
            onclick={() => void copyText(worker.pubkey, 'Worker pubkey')}>
            <Copy class="h-3 w-3" />
          </button>
          <a
            class="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Open profile"
            href={`nostr:${worker.pubkey}`}
            target="_blank"
            rel="noreferrer">
            <ExternalLink class="h-3 w-3" />
          </a>
        </div>
        <div class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {#if worker.architecture}<span>{worker.architecture}</span>{/if}
          {#if worker.actVersion}<span>act {worker.actVersion}</span>{/if}
          {#if worker.pricing?.perSecondRate}<span>{worker.pricing.perSecondRate} {worker.pricing.unit || 'sat'}/s</span>{/if}
        </div>
      </section>
    {/if}
  </div>
</aside>
