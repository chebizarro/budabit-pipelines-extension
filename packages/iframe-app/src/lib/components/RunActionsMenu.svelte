<script lang="ts">
  import {Check, ExternalLink, MoreHorizontal} from '@lucide/svelte'
  import type {WorkflowRun, LoomWorker} from '../types'

  interface Props {
    run: WorkflowRun
    worker: LoomWorker | null | undefined
    currentView: 'hiveci' | 'loom'
    onViewChange: (view: 'hiveci' | 'loom') => void
    onCopyRunId: () => void
    onCopyCommit: () => void
  }

  const {run, worker, currentView, onViewChange, onCopyRunId, onCopyCommit}: Props = $props()

  let open = $state(false)
  let button: HTMLButtonElement | undefined = $state()
  let panel: HTMLDivElement | undefined = $state()

  function nostrHref(id: string | undefined) {
    return id ? `nostr:${id}` : undefined
  }

  const externalLinks = $derived([
    {label: 'Hive CI run event', href: nostrHref(run.runEvent?.id)},
    {label: 'Hive CI result event', href: nostrHref(run.workflowLogEvent?.id)},
    {label: 'Loom job event', href: nostrHref(run.loomJobEvent?.id)},
    {label: 'Loom result event', href: nostrHref(run.loomResultEvent?.id)},
    {label: 'Loom worker', href: nostrHref(worker?.pubkey)},
  ])

  function onDocumentPointerDown(event: PointerEvent) {
    if (!open) return
    const target = event.target as Node
    if (button?.contains(target)) return
    if (panel?.contains(target)) return
    open = false
  }

  $effect(() => {
    if (!open) return
    document.addEventListener('pointerdown', onDocumentPointerDown)
    return () => document.removeEventListener('pointerdown', onDocumentPointerDown)
  })
</script>

<div class="relative">
  <button
    bind:this={button}
    type="button"
    class="rounded-md border border-input bg-background p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
    title="More actions"
    onclick={() => (open = !open)}>
    <MoreHorizontal class="h-4 w-4" />
  </button>

  {#if open}
    <div
      bind:this={panel}
      class="absolute right-0 z-20 mt-2 w-64 rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">

      <div class="border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        View
      </div>
      <button
        class="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-accent"
        onclick={() => { onViewChange('hiveci'); open = false }}>
        Hive CI
        {#if currentView === 'hiveci'}<Check class="h-4 w-4 text-primary" />{/if}
      </button>
      <button
        class="flex w-full items-center justify-between px-3 py-2 text-sm hover:bg-accent"
        onclick={() => { onViewChange('loom'); open = false }}>
        Loom
        {#if currentView === 'loom'}<Check class="h-4 w-4 text-primary" />{/if}
      </button>

      <div class="border-t border-b border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Open on Nostr
      </div>
      {#each externalLinks as link (link.label)}
        {#if link.href}
          <a
            class="flex items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-accent"
            href={link.href}
            target="_blank"
            rel="noreferrer"
            onclick={() => (open = false)}>
            <span class="truncate">{link.label}</span>
            <ExternalLink class="h-3.5 w-3.5 text-muted-foreground" />
          </a>
        {/if}
      {/each}

      <div class="border-t border-border px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Copy
      </div>
      <button class="flex w-full items-center px-3 py-2 text-sm hover:bg-accent" onclick={() => { onCopyRunId(); open = false }}>
        Run ID
      </button>
      {#if run.commit}
        <button class="flex w-full items-center px-3 py-2 text-sm hover:bg-accent" onclick={() => { onCopyCommit(); open = false }}>
          Commit SHA
        </button>
      {/if}
    </div>
  {/if}
</div>
