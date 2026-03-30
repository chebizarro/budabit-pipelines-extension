<script lang="ts">
  import type { LoomWorker, RerunDraft } from '../types'

  interface Props {
    title: string
    description: string
    submissionMode: 'new' | 'rerun' | null
    rerunDraft: RerunDraft
    rerunCommandMode?: 'reuse' | 'regenerate'
    rerunArgsText?: string
    rerunPaymentToken?: string
    rerunSecrets?: {key: string; value: string}[]
    rerunSubmitting?: boolean
    discoveredWorkers?: LoomWorker[]
    loadingWorkers?: boolean
    walletAvailable?: boolean
    walletLoading?: boolean
    walletError?: string | null
    walletTotalBalance?: number
    walletBalancesByMint?: Record<string, number>
    visibleMintOptions?: string[]
    selectedMint?: string
    paymentAmount?: number
    generatingPaymentToken?: boolean
    autoTokenPromptOpen?: boolean
    selectedWorker?: LoomWorker | null
    compatibleMints?: string[]
    signerError?: string | null
    runnerScriptTemplate?: string
    runnerScriptAutoManaged?: boolean
    canGenerateSuggestedToken?: boolean
    suggestedPaymentAmount: (worker: LoomWorker | null) => number
    onRefreshWorkers: () => void
    onRefreshWallet: () => void
    onGeneratePaymentToken: () => void
    onConfirmAutoTokenGeneration: () => void
    onDismissAutoTokenGeneration: () => void
    onAddRerunSecret: () => void
    onRemoveRerunSecret: (index: number) => void
    onSetRerunCommandMode?: (mode: 'reuse' | 'regenerate') => void
    onRegenerateTemplate: () => void
    onSubmit: () => void
    onConnectSigner: () => void
  }

  let {
    title,
    description,
    submissionMode,
    rerunDraft = $bindable(),
    rerunCommandMode = $bindable('reuse'),
    rerunArgsText = $bindable(''),
    rerunPaymentToken = $bindable(''),
    rerunSecrets = $bindable([{key: '', value: ''}]),
    rerunSubmitting = false,
    discoveredWorkers = [],
    loadingWorkers = false,
    walletAvailable = false,
    walletLoading = false,
    walletError = null,
    walletTotalBalance = 0,
    walletBalancesByMint = {},
    visibleMintOptions = [],
    selectedMint = $bindable(''),
    paymentAmount = $bindable(100),
    generatingPaymentToken = false,
    autoTokenPromptOpen = false,
    selectedWorker = null,
    compatibleMints = [],
    signerError = null,
    runnerScriptTemplate = $bindable(''),
    runnerScriptAutoManaged = false,
    canGenerateSuggestedToken = false,
    suggestedPaymentAmount,
    onRefreshWorkers,
    onRefreshWallet,
    onGeneratePaymentToken,
    onConfirmAutoTokenGeneration,
    onDismissAutoTokenGeneration,
    onAddRerunSecret,
    onRemoveRerunSecret,
    onSetRerunCommandMode,
    onRegenerateTemplate,
    onSubmit,
    onConnectSigner,
  }: Props = $props()

  const isFormValid = $derived(
    !!rerunDraft.workerPubkey &&
    !!rerunPaymentToken.trim() &&
    (submissionMode !== 'new' || !!rerunDraft.workflowPath)
  )

  const validationMessage = $derived.by(() => {
    if (!rerunDraft.workerPubkey) return 'Please select a worker'
    if (!rerunPaymentToken.trim()) return 'Payment token is required'
    if (submissionMode === 'new' && !rerunDraft.workflowPath) return 'Workflow path is required'
    return ''
  })
</script>

<div class="space-y-4 rounded-md border border-border bg-background/60 p-4">
  <div>
    <h4 class="text-sm font-semibold">{title}</h4>
    <p class="mt-1 text-xs text-muted-foreground">{description}</p>
  </div>

  {#if submissionMode === 'rerun' && onSetRerunCommandMode}
    <div class="space-y-2">
      <span class="text-xs text-muted-foreground">Rerun command mode</span>
      <div class="flex flex-wrap gap-2">
        <button
          class={`rounded-md border px-3 py-2 text-sm ${rerunCommandMode === 'reuse'
            ? 'border-primary/40 bg-primary/10'
            : 'border-input hover:bg-accent'}`}
          onclick={() => onSetRerunCommandMode('reuse')}>
          Reuse original command
        </button>
        <button
          class={`rounded-md border px-3 py-2 text-sm ${rerunCommandMode === 'regenerate'
            ? 'border-primary/40 bg-primary/10'
            : 'border-input hover:bg-accent'}`}
          onclick={() => onSetRerunCommandMode('regenerate')}>
          Regenerate from template
        </button>
      </div>
    </div>
  {/if}

  <div class="grid gap-3 sm:grid-cols-2">
    <label class="space-y-1 text-sm">
      <span class="text-xs text-muted-foreground">Workflow</span>
      <input
        class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        bind:value={rerunDraft.workflowPath} />
    </label>
    <label class="space-y-1 text-sm">
      <span class="text-xs text-muted-foreground">Worker pubkey</span>
      <input
        class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        bind:value={rerunDraft.workerPubkey} />
    </label>
    <label class="space-y-1 text-sm">
      <span class="text-xs text-muted-foreground">Branch</span>
      <input
        class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        bind:value={rerunDraft.branch} />
    </label>
    <label class="space-y-1 text-sm">
      <span class="text-xs text-muted-foreground">Commit</span>
      <input
        class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        bind:value={rerunDraft.commit} />
    </label>
  </div>

  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <span class="text-xs text-muted-foreground">Worker discovery</span>
      <button class="text-xs text-primary hover:underline" onclick={onRefreshWorkers}>
        {loadingWorkers ? 'Refreshing…' : 'Refresh workers'}
      </button>
    </div>
    {#if discoveredWorkers.length > 0}
      <div class="grid gap-2">
        {#each discoveredWorkers as worker (worker.pubkey)}
          <button
            class={`rounded-md border p-3 text-left text-sm ${rerunDraft.workerPubkey === worker.pubkey
              ? 'border-primary/40 bg-primary/10'
              : 'border-input hover:bg-accent'}`}
            onclick={() => (rerunDraft.workerPubkey = worker.pubkey)}>
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="font-medium">{worker.name}</div>
                <div class="mt-1 break-all text-xs text-muted-foreground">{worker.pubkey}</div>
              </div>
              <span class={`h-2.5 w-2.5 rounded-full ${worker.online ? 'bg-green-400' : 'bg-zinc-500'}`}></span>
            </div>
          </button>
        {/each}
      </div>
    {:else}
      <div class="rounded-md border border-input p-3 text-sm text-muted-foreground">
        {loadingWorkers ? 'Discovering workers…' : 'No workers discovered yet.'}
      </div>
    {/if}
  </div>

  <label class="block space-y-1 text-sm">
    <span class="text-xs text-muted-foreground">Command</span>
    {#if submissionMode === 'new' || (submissionMode === 'rerun' && rerunCommandMode === 'regenerate')}
      <div class="rounded-md border border-input bg-background px-3 py-2 text-sm text-muted-foreground">
        Auto-generated inline runner script via <span class="font-mono">bash -lc</span>
      </div>
    {:else}
      <input
        class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        bind:value={rerunDraft.command} />
    {/if}
  </label>

  <label class="block space-y-1 text-sm">
    <span class="text-xs text-muted-foreground">
      {submissionMode === 'new' || (submissionMode === 'rerun' && rerunCommandMode === 'regenerate')
        ? 'Runner script template'
        : 'Arguments (one per line)'}
    </span>
    {#if submissionMode === 'new' || (submissionMode === 'rerun' && rerunCommandMode === 'regenerate')}
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <span class="text-xs text-muted-foreground">
            Prefilled from the Hive CI runner and updated from the selected workflow and worker.
          </span>
          <button class="text-xs text-primary hover:underline" onclick={onRegenerateTemplate}>
            Regenerate template
          </button>
        </div>
        <textarea
          class="min-h-56 w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
          bind:value={runnerScriptTemplate}
          oninput={() => (runnerScriptAutoManaged = false)}></textarea>
      </div>
    {:else}
      <textarea
        class="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
        bind:value={rerunArgsText}></textarea>
    {/if}
  </label>

  <label class="block space-y-1 text-sm">
    <span class="text-xs text-muted-foreground">Fresh payment token</span>
    <div class="grid gap-2 rounded-md border border-dashed border-border p-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
      <label class="space-y-1 text-sm">
        <span class="text-xs text-muted-foreground">Mint</span>
        <select
          class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          bind:value={selectedMint}
          disabled={!walletAvailable || walletLoading}>
          <option value="">Select a mint</option>
          {#each visibleMintOptions as mint}
            <option value={mint}>
              {mint} ({(walletBalancesByMint[mint] || 0).toLocaleString()} sats)
            </option>
          {/each}
        </select>
      </label>
      <label class="space-y-1 text-sm">
        <span class="text-xs text-muted-foreground">Amount</span>
        <input
          class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          type="number"
          min="1"
          bind:value={paymentAmount} />
      </label>
      <div class="flex flex-wrap gap-2">
        <button class="rounded-md border border-input px-3 py-2 text-sm hover:bg-accent" onclick={onRefreshWallet}>
          {walletLoading ? 'Loading…' : 'Refresh wallet'}
        </button>
        <button
          class="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm hover:bg-primary/20"
          onclick={onGeneratePaymentToken}
          disabled={!walletAvailable || generatingPaymentToken}>
          {generatingPaymentToken ? 'Generating…' : 'Generate token'}
        </button>
      </div>
    </div>
    <div class="text-xs text-muted-foreground">
      {#if walletAvailable}
        Wallet available. Total balance: {walletTotalBalance.toLocaleString()} sats.
        {#if selectedWorker}
          Compatible mints: {compatibleMints.length > 0 ? compatibleMints.join(', ') : 'none from current wallet'}.
          Suggested amount: {suggestedPaymentAmount(selectedWorker)} sats.
        {/if}
      {:else if walletError}
        Wallet bridge unavailable: {walletError}
      {:else}
        Wallet bridge not yet checked.
      {/if}
    </div>
    {#if autoTokenPromptOpen && selectedWorker}
      <div class="rounded-md border border-primary/20 bg-primary/10 p-3 text-sm">
        <div class="font-medium">Generate suggested payment token?</div>
        <div class="mt-1 text-xs text-muted-foreground">
          Use {selectedMint} to create a {paymentAmount.toLocaleString()} sat token
          for {selectedWorker.name}. The host wallet confirmation UI will still be shown before spending.
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          <button
            class="rounded-md border border-primary/30 bg-primary/20 px-3 py-2 text-sm hover:bg-primary/30"
            onclick={onConfirmAutoTokenGeneration}
            disabled={generatingPaymentToken}>
            {generatingPaymentToken ? 'Generating…' : 'Confirm and generate'}
          </button>
          <button class="rounded-md border border-input px-3 py-2 text-sm hover:bg-accent" onclick={onDismissAutoTokenGeneration}>
            Not now
          </button>
        </div>
      </div>
    {/if}
    {#if walletAvailable}
      <div class="flex flex-wrap items-center gap-2 text-xs">
        <button
          class="rounded-md border border-input px-2 py-1 hover:bg-accent disabled:opacity-50"
          onclick={onGeneratePaymentToken}
          disabled={!canGenerateSuggestedToken || generatingPaymentToken}>
          Generate suggested token
        </button>
        {#if selectedMint}
          <span class="text-muted-foreground">
            Selected mint balance: {(walletBalancesByMint[selectedMint] || 0).toLocaleString()} sats
          </span>
        {/if}
      </div>
    {/if}
    <textarea
      class="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
      bind:value={rerunPaymentToken}
      placeholder="Paste a fresh Cashu token or other worker-compatible payment payload"></textarea>
  </label>

  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <span class="text-xs text-muted-foreground">Environment variables</span>
    </div>
    {#each rerunDraft.envVars as envVar, index (index)}
      <div class="grid gap-2 sm:grid-cols-2">
        <input
          class="rounded-md border border-input bg-background px-3 py-2 text-sm"
          bind:value={envVar.key}
          placeholder="KEY" />
        <input
          class="rounded-md border border-input bg-background px-3 py-2 text-sm"
          bind:value={envVar.value}
          placeholder="value" />
      </div>
    {/each}
  </div>

  <div class="space-y-2">
    <div class="flex items-center justify-between">
      <span class="text-xs text-muted-foreground">Secrets to re-enter</span>
      <button class="text-xs text-primary hover:underline" onclick={onAddRerunSecret}>
        Add secret
      </button>
    </div>
    {#each rerunSecrets as secret, index (index)}
      <div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <input
          class="rounded-md border border-input bg-background px-3 py-2 text-sm"
          bind:value={secret.key}
          placeholder="SECRET_KEY" />
        <input
          class="rounded-md border border-input bg-background px-3 py-2 text-sm"
          bind:value={secret.value}
          placeholder="secret value" />
        <button
          class="rounded-md border border-input px-3 py-2 text-sm hover:bg-accent"
          onclick={() => onRemoveRerunSecret(index)}>
          Remove
        </button>
      </div>
    {/each}
  </div>

  {#if signerError}
    <div class="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-200">
      {signerError}
    </div>
  {/if}

  {#if !isFormValid && validationMessage}
    <div class="rounded-md border border-yellow-500/20 bg-yellow-500/10 p-3 text-xs text-yellow-200">
      {validationMessage}
    </div>
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    <button
      class="inline-flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm hover:bg-primary/20 disabled:opacity-50 disabled:cursor-not-allowed"
      onclick={onSubmit}
      disabled={rerunSubmitting || !isFormValid}>
      <span class={`${rerunSubmitting ? 'animate-pulse' : ''}`}>▶</span>
      {rerunSubmitting ? 'Submitting…' : submissionMode === 'new' ? 'Submit run' : 'Submit rerun'}
    </button>
    <button
      class="rounded-md border border-input px-3 py-2 text-sm hover:bg-accent"
      onclick={onConnectSigner}>
      Connect signer
    </button>
  </div>
</div>
