<script lang="ts">
  import { createWidgetBridge, type WidgetBridge } from '@flotilla/ext-shared';
  import {
    AlertCircle,
    ArrowLeft,
    Check,
    ChevronRight,
    Circle,
    Clock,
    ExternalLink,
    Filter,
    GitCommit,
    Play,
    RefreshCw,
    RotateCw,
    SearchX,
    Server,
    Workflow,
    X,
  } from '@lucide/svelte';
  import { friendlyErrorMessage, getHostOrigin, normalizeRepo, transformHostContext } from './lib/context';
  import {
    eventERefs,
    eventSummary,
    externalUrlForEvent,
    buildRerunDraft,
    publicLinkForRun,
    statusLabel,
  } from './lib/pipelines';
  import { connectNip07Signer } from './lib/nip07';
  import {
    buildAutoTokenCandidateKey,
    formatDuration,
    formatTimeAgo,
    getStatusBadge,
    getStatusColor,
    getStatusIcon,
    repoName,
    shortId,
    suggestedPaymentAmount,
  } from './lib/presentation';
  import { buildRunnerScriptTemplate } from './lib/runner-script';
  import {
    canGenerateSuggestedToken as canGenerateSuggestedTokenValue,
    createNewRunDraft,
    getBestCompatibleMint,
    getCompatibleMints,
    getSelectedWorker,
    getVisibleMintOptions,
  } from './lib/submission';
  import RunSubmissionForm from './lib/components/RunSubmissionForm.svelte';
  import {
    generatePaymentTokenController,
    loadRunDetailController,
    refreshRunsController,
    refreshWalletController,
    refreshWorkersController,
    submitRunController,
  } from './lib/controllers';
  import type {
    RepoContext,
    RepoContextNormalized,
    RerunDraft,
    LoomWorker,
    WorkflowRun,
    WorkflowRunDetail,
    WorkflowStatus,
  } from './lib/types';

  let bridge = $state<WidgetBridge | null>(null);
  let repoCtx = $state<RepoContext | null>(null);
  let repo = $derived(normalizeRepo(repoCtx));

  let loading = $state(false);
  let error = $state<string | null>(null);
  let workflowRuns = $state<WorkflowRun[]>([]);

  let detailLoading = $state(false);
  let detailError = $state<string | null>(null);
  let selectedRunId = $state<string | null>(null);
  let selectedRunDetail = $state<WorkflowRunDetail | null>(null);
  let signerPubkey = $state<string | null>(null);
  let signerError = $state<string | null>(null);
  let rerunDraft = $state<RerunDraft | null>(null);
  let submissionMode = $state<'new' | 'rerun' | null>(null);
  let rerunArgsText = $state('');
  let rerunPaymentToken = $state('');
  let rerunSecrets = $state([{ key: '', value: '' }]);
  let rerunSubmitting = $state(false);
  let discoveredWorkers = $state<LoomWorker[]>([]);
  let loadingWorkers = $state(false);
  let walletAvailable = $state(false);
  let walletLoading = $state(false);
  let walletError = $state<string | null>(null);
  let walletTotalBalance = $state(0);
  let walletBalancesByMint = $state<Record<string, number>>({});
  let walletMints = $state<string[]>([]);
  let selectedMint = $state('');
  let paymentAmount = $state(100);
  let generatingPaymentToken = $state(false);
  let autoTokenPromptOpen = $state(false);
  let autoTokenPromptKey = $state('');
  let autoTokenDismissedKey = $state('');
  let runnerScriptTemplate = $state('');
  let runnerScriptAutoManaged = $state(true);
  let rerunCommandMode = $state<'reuse' | 'regenerate'>('reuse');

  let searchTerm = $state('');
  let statusFilter = $state<string>('all');
  let showFilters = $state(false);

  let loadSeq = 0;
  let detailSeq = 0;

  const selectedWorker = $derived(getSelectedWorker(rerunDraft, discoveredWorkers));

  const compatibleMints = $derived.by(() => getCompatibleMints(selectedWorker, walletMints));

  const visibleMintOptions = $derived(getVisibleMintOptions(compatibleMints, walletMints));

  const canGenerateSuggestedToken = $derived(
    canGenerateSuggestedTokenValue({
      walletAvailable,
      selectedMint,
      paymentAmount,
      walletBalancesByMint,
    })
  );

  const autoTokenCandidateKey = $derived.by(() =>
    buildAutoTokenCandidateKey({
      draft: rerunDraft,
      selectedWorker,
      selectedMint,
      canGenerateSuggestedToken,
      rerunPaymentToken,
      submissionMode,
      paymentAmount,
    })
  );

  async function showToast(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') {
    if (!bridge) return;

    try {
      await bridge.request('ui:toast', { message, type });
    } catch {
      // pass
    }
  }

  async function refreshRuns(nextRepo: RepoContextNormalized | null = repo) {
    if (!bridge || !nextRepo) return;

    const seq = ++loadSeq;
    loading = true;
    error = null;

    try {
      workflowRuns = await refreshRunsController(bridge, nextRepo)
      if (selectedRunId) {
        const refreshed = workflowRuns.find(run => run.id === selectedRunId);
        if (!refreshed) {
          selectedRunId = null;
          selectedRunDetail = null;
        }
      }
    } catch (err) {
      if (seq !== loadSeq) return;
      error = friendlyErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  async function openRun(run: WorkflowRun) {
    if (!bridge || !repo) return;

    const seq = ++detailSeq;
    selectedRunId = run.id;
    selectedRunDetail = null;
    detailError = null;
    detailLoading = true;

    try {
      selectedRunDetail = await loadRunDetailController(bridge, repo, run.id)
      if (!selectedRunDetail) {
        detailError = 'Run details were not found on the configured relays.';
      }
    } catch (err) {
      if (seq !== detailSeq) return;
      detailError = friendlyErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === detailSeq) detailLoading = false;
    }
  }

  function closeRun() {
    selectedRunId = null;
    selectedRunDetail = null;
    detailError = null;
    detailLoading = false;
    rerunDraft = null;
    submissionMode = null;
    rerunArgsText = '';
    rerunPaymentToken = '';
    rerunSecrets = [{ key: '', value: '' }];
    rerunCommandMode = 'reuse';
    runnerScriptTemplate = '';
    runnerScriptAutoManaged = true;
    autoTokenPromptOpen = false;
    autoTokenPromptKey = '';
    autoTokenDismissedKey = '';
  }

  function resetFilters() {
    statusFilter = 'all';
    searchTerm = '';
  }

  function addRerunSecret() {
    rerunSecrets = [...rerunSecrets, { key: '', value: '' }];
  }

  function removeRerunSecret(index: number) {
    rerunSecrets = rerunSecrets.filter((_, currentIndex) => currentIndex !== index);
  }

  async function connectSigner() {
    try {
      signerError = null;
      signerPubkey = await connectNip07Signer();
      await showToast('Connected NIP-07 signer', 'success');
    } catch (err) {
      signerError = friendlyErrorMessage(err instanceof Error ? err.message : String(err));
      await showToast(signerError, 'error');
    }
  }

  async function refreshWorkers() {
    if (!bridge || !repo) return;

    loadingWorkers = true;
    try {
      const nextState = await refreshWorkersController(bridge, repo, rerunDraft?.workerPubkey)
      discoveredWorkers = nextState.workers
      if (rerunDraft && !rerunDraft.workerPubkey) {
        rerunDraft.workerPubkey = nextState.nextWorkerPubkey
      }
    } catch (err) {
      signerError = friendlyErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      loadingWorkers = false;
    }
  }

  async function refreshWallet() {
    if (!bridge) return;

    walletLoading = true;
    walletError = null;

    try {
      const state = await refreshWalletController(bridge, selectedMint)
      walletAvailable = true
      walletTotalBalance = state.totalBalance
      walletBalancesByMint = state.balancesByMint
      walletMints = state.mints
      selectedMint = state.nextSelectedMint
    } catch (err) {
      walletAvailable = false;
      walletError = friendlyErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      walletLoading = false;
    }
  }

  async function generatePaymentToken() {
    if (!bridge) return;
    if (!selectedMint) {
      walletError = 'Select a mint first.';
      return;
    }
    if (paymentAmount <= 0) {
      walletError = 'Payment amount must be greater than zero.';
      return;
    }

    generatingPaymentToken = true;
    walletError = null;

    try {
      const token = await generatePaymentTokenController(
        bridge,
        paymentAmount,
        selectedMint,
        submissionMode
      )
      rerunPaymentToken = token;
      await refreshWallet();
      await showToast('Generated Cashu payment token', 'success');
    } catch (err) {
      walletError = friendlyErrorMessage(err instanceof Error ? err.message : String(err));
      await showToast(walletError, 'error');
      autoTokenDismissedKey = '';
    } finally {
      generatingPaymentToken = false;
    }
  }

  async function confirmAutoTokenGeneration() {
    autoTokenPromptOpen = false;
    autoTokenDismissedKey = autoTokenPromptKey;
    await generatePaymentToken();
  }

  function dismissAutoTokenGeneration() {
    autoTokenPromptOpen = false;
    autoTokenDismissedKey = autoTokenPromptKey;
  }

  $effect(() => {
    if (!bridge) return;
    void refreshWallet();
  });

  $effect(() => {
    if (!selectedWorker) return;

    const bestCompatibleMint = getBestCompatibleMint(compatibleMints, walletBalancesByMint)

    if (bestCompatibleMint && selectedMint !== bestCompatibleMint) {
      selectedMint = bestCompatibleMint;
    }

    const suggested = suggestedPaymentAmount(selectedWorker);
    if (!rerunPaymentToken && paymentAmount <= 0) {
      paymentAmount = suggested;
    } else if (!rerunPaymentToken && paymentAmount === 100 && suggested !== 100) {
      paymentAmount = suggested;
    }
  });

  $effect(() => {
    const key = autoTokenCandidateKey;
    if (!key) {
      autoTokenPromptOpen = false;
      autoTokenPromptKey = '';
      return;
    }

    if (key === autoTokenDismissedKey || generatingPaymentToken) {
      return;
    }

    if (key !== autoTokenPromptKey) {
      autoTokenPromptKey = key;
      autoTokenPromptOpen = true;
    }
  });

  $effect(() => {
    if (!rerunDraft || !runnerScriptAutoManaged) return;
    if (submissionMode !== 'new' && !(submissionMode === 'rerun' && rerunCommandMode === 'regenerate')) {
      return;
    }

    runnerScriptTemplate = buildRunnerScriptTemplate(
      rerunDraft.workflowPath,
      selectedWorker,
      rerunDraft.branch
    );
  });

  function openNewRunForm() {
    if (!repo) return

    selectedRunId = null;
    selectedRunDetail = null;
    detailError = null;
    rerunDraft = createNewRunDraft(repo);
    if (!rerunDraft) return
    rerunArgsText = rerunDraft.args.join('\n');
    rerunPaymentToken = '';
    rerunSecrets = [{ key: '', value: '' }];
    rerunCommandMode = 'reuse';
    runnerScriptAutoManaged = true;
    runnerScriptTemplate = buildRunnerScriptTemplate('', null, 'main');
    autoTokenPromptOpen = false;
    autoTokenPromptKey = '';
    autoTokenDismissedKey = '';
    signerError = null;
    submissionMode = 'new';
    void refreshWorkers();
    void refreshWallet();
  }

  function openRerunForm() {
    if (!repo || !selectedRunDetail) return;

    const nextDraft = buildRerunDraft(repo, selectedRunDetail);
    if (!nextDraft) {
      signerError =
        'This run does not include enough loom job metadata to prepare a rerun inside the widget.';
      return;
    }

    rerunDraft = {
      ...nextDraft,
      envVars: nextDraft.envVars.map(entry => ({ ...entry })),
    };
    rerunArgsText = nextDraft.args.join('\n');
    rerunPaymentToken = '';
    rerunSecrets = [{ key: '', value: '' }];
    rerunCommandMode = 'reuse';
    runnerScriptAutoManaged = true;
    runnerScriptTemplate = buildRunnerScriptTemplate(
      nextDraft.workflowPath,
      null,
      nextDraft.branch
    );
    autoTokenPromptOpen = false;
    autoTokenPromptKey = '';
    autoTokenDismissedKey = '';
    signerError = null;
    submissionMode = 'rerun';
    void refreshWorkers();
    void refreshWallet();
  }

  async function submitRerunRequest() {
    if (!signerPubkey) {
      await connectSigner();
      if (!signerPubkey) return;
    }

    if (!rerunDraft) return;
    if (!rerunPaymentToken.trim()) {
      signerError = 'A fresh payment token is required for reruns.';
      return;
    }

    rerunSubmitting = true;
    signerError = null;

    try {
      const runId = await submitRunController({
        signerPubkey,
        submissionMode,
        rerunCommandMode,
        rerunDraft,
        rerunArgsText,
        rerunPaymentToken,
        runnerScriptTemplate,
        rerunSecrets,
      })

      rerunDraft = null;
      submissionMode = null;
      rerunArgsText = '';
      rerunPaymentToken = '';
      rerunSecrets = [{ key: '', value: '' }];
      autoTokenPromptOpen = false;
      autoTokenPromptKey = '';
      autoTokenDismissedKey = '';

      await showToast(`Rerun submitted: ${runId.slice(0, 8)}`, 'success');
      await refreshRuns(repo);
      const newRun = workflowRuns.find(run => run.id === runId);
      if (newRun) {
        await openRun(newRun);
      }
    } catch (err) {
      signerError = friendlyErrorMessage(err instanceof Error ? err.message : String(err));
      await showToast(signerError, 'error');
    } finally {
      rerunSubmitting = false;
    }
  }

  const filteredRuns = $derived.by(() => {
    return workflowRuns.filter(run => {
      if (searchTerm) {
        const query = searchTerm.toLowerCase();
        const fields = [run.name, run.branch, run.commitMessage, run.commit, run.actor, run.workflowPath || ''];
        if (!fields.some(field => field.toLowerCase().includes(query))) return false;
      }

      if (statusFilter !== 'all' && run.status !== statusFilter) return false;

      return true;
    });
  });

  $effect(() => {
    const b = createWidgetBridge({
      targetWindow: window.parent,
      targetOrigin: getHostOrigin(),
      timeoutMs: 0,
    });

    bridge = b;

    const offInit = b.onEvent('widget:init', (payload: any) => {
      if (payload?.repoContext) {
        const nextRepoCtx = transformHostContext(payload.repoContext);
        repoCtx = nextRepoCtx;
        void refreshRuns(normalizeRepo(nextRepoCtx));
      }
    });

    const offMounted = b.onEvent('widget:mounted', () => {
      void refreshRuns();
    });

    const offUnmounting = b.onEvent('widget:unmounting', () => {
      loadSeq += 1;
      detailSeq += 1;
      workflowRuns = [];
      closeRun();
    });

    const offContext = b.onEvent('context:update', (ctx: any) => {
      const nextRepoCtx = ctx ? transformHostContext(ctx) : null;
      repoCtx = nextRepoCtx;
      closeRun();
      void refreshRuns(normalizeRepo(nextRepoCtx));
    });

    const offRepoUpdate = b.onEvent('context:repoUpdate', (ctx: any) => {
      const nextRepoCtx = transformHostContext(ctx);
      repoCtx = nextRepoCtx;
      closeRun();
      void refreshRuns(normalizeRepo(nextRepoCtx));
    });

    return () => {
      offInit();
      offMounted();
      offUnmounting();
      offContext();
      offRepoUpdate();
      b.destroy();
      bridge = null;
    };
  });
</script>

<div class="min-h-screen bg-background p-4 text-foreground">
  <div class="mx-auto max-w-7xl space-y-4">
    <div class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div>
        <div class="flex items-center gap-2">
          <Workflow class="h-5 w-5 text-primary" />
          <h2 class="text-xl font-semibold">CI/CD Pipelines</h2>
        </div>
        <p class="mt-1 text-sm text-muted-foreground">{repoName(repo)}</p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button
          class="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent"
          onclick={() => void connectSigner()}>
          <Check class={`h-4 w-4 ${signerPubkey ? 'text-green-400' : 'text-muted-foreground'}`} />
          {signerPubkey ? `${shortId(signerPubkey, 12)} connected` : 'Connect NIP-07'}
        </button>
        <button
          class="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent"
          onclick={() => void refreshRuns()}>
          <RefreshCw class={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
        <button
          class="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent"
          onclick={openNewRunForm}>
          <Play class="h-4 w-4" />
          New run
        </button>
      </div>
    </div>

    <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
      <section class="space-y-4">
        <div class="flex items-center gap-2">
          <div class="relative flex-1">
            <input
              class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
              bind:value={searchTerm}
              type="text"
              placeholder="Search runs, commits, branches, or actors…" />
          </div>
          <button
            class="rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent"
            onclick={() => (showFilters = !showFilters)}>
            <Filter class="h-4 w-4" />
          </button>
        </div>

        {#if showFilters}
          <div class="rounded-lg border border-border bg-card p-4">
            <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div class="space-y-2">
                <label for="status-filter" class="text-sm font-medium">Status</label>
                <select
                  id="status-filter"
                  bind:value={statusFilter}
                  class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground">
                  <option value="all">All statuses</option>
                  <option value="success">Success</option>
                  <option value="failure">Failure</option>
                  <option value="running">Running</option>
                  <option value="queued">Queued</option>
                  <option value="pending">Pending</option>
                </select>
              </div>
              <button
                class="rounded-md border border-input px-3 py-2 text-sm hover:bg-accent"
                onclick={resetFilters}>
                Reset filters
              </button>
            </div>
          </div>
        {/if}

        {#if loading}
          <div class="flex items-center justify-center rounded-lg border border-border bg-card py-16">
            <RotateCw class="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        {:else if error}
          <div class="flex flex-col items-center justify-center rounded-lg border border-border bg-card py-16 text-center text-muted-foreground">
            <AlertCircle class="mb-3 h-8 w-8" />
            <p class="max-w-xl text-sm">{error}</p>
          </div>
        {:else if filteredRuns.length === 0}
          <div class="flex flex-col items-center justify-center rounded-lg border border-border bg-card py-16 text-muted-foreground">
            <SearchX class="mb-3 h-8 w-8" />
            <p class="text-sm">No pipeline runs found.</p>
          </div>
        {:else}
          <div class="space-y-2">
            {#each filteredRuns as run (run.id)}
              {@const StatusIcon = getStatusIcon(run.status)}
              <button
                class={`group w-full rounded-lg border p-4 text-left transition-colors hover:bg-accent/40 ${selectedRunId === run.id
                  ? 'border-primary/40 bg-card/95'
                  : 'border-border bg-card'}`}
                onclick={() => void openRun(run)}>
                <div class="flex items-start gap-4">
                  <div class={`mt-0.5 shrink-0 ${getStatusColor(run.status)}`}>
                    {#if run.status === 'running' || run.status === 'in_progress'}
                      <RotateCw class="h-5 w-5 animate-spin" />
                    {:else}
                      <StatusIcon class="h-5 w-5" />
                    {/if}
                  </div>

                  <div class="min-w-0 flex-1 space-y-2">
                    <div class="flex flex-wrap items-center gap-2">
                      <h3 class="truncate text-base font-semibold">{run.name}</h3>
                      <span class={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${getStatusBadge(run.status)}`}>
                        {statusLabel(run.status)}
                      </span>
                    </div>

                    <div class="truncate text-sm text-muted-foreground">{run.workflowPath || run.commitMessage}</div>

                    <div class="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                      <div class="flex items-center gap-1">
                        <GitCommit class="h-3 w-3" />
                        <span class="font-mono">{shortId(run.commit || run.id, 7)}</span>
                      </div>
                      <div class="flex items-center gap-1">
                        <span>branch</span>
                        <span class="font-medium text-foreground/90">{run.branch}</span>
                      </div>
                      <div class="flex items-center gap-1">
                        <Clock class="h-3 w-3" />
                        <span>{formatTimeAgo(run.createdAt)}</span>
                      </div>
                      {#if run.duration}
                        <div>{formatDuration(run.duration)}</div>
                      {/if}
                    </div>
                  </div>

                  <div class="shrink-0 text-muted-foreground transition-colors group-hover:text-foreground">
                    <ChevronRight class="h-5 w-5" />
                  </div>
                </div>
              </button>
            {/each}
          </div>
        {/if}

        <div class="rounded-lg border border-border bg-card p-4">
          <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <div class="text-xs text-muted-foreground">Total runs</div>
              <div class="text-2xl font-bold">{workflowRuns.length}</div>
            </div>
            <div>
              <div class="text-xs text-muted-foreground">Success</div>
              <div class="text-2xl font-bold text-green-400">{workflowRuns.filter(run => run.status === 'success').length}</div>
            </div>
            <div>
              <div class="text-xs text-muted-foreground">Failed</div>
              <div class="text-2xl font-bold text-red-400">{workflowRuns.filter(run => run.status === 'failure').length}</div>
            </div>
            <div>
              <div class="text-xs text-muted-foreground">Active</div>
              <div class="text-2xl font-bold text-yellow-400">
                {workflowRuns.filter(run => ['running', 'in_progress', 'queued', 'pending'].includes(run.status)).length}
              </div>
            </div>
          </div>
        </div>
      </section>

      <aside class="rounded-lg border border-border bg-card p-4 xl:sticky xl:top-4 xl:self-start">
        {#if detailLoading}
          <div class="flex min-h-[320px] items-center justify-center">
            <RotateCw class="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        {:else if detailError}
          <div class="flex min-h-[320px] flex-col items-center justify-center text-center text-muted-foreground">
            <AlertCircle class="mb-3 h-8 w-8" />
            <p class="text-sm">{detailError}</p>
          </div>
        {:else if selectedRunDetail}
          {@const run = selectedRunDetail.run}
          {@const StatusIcon = getStatusIcon(run.status)}
          <div class="space-y-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="flex items-center gap-2">
                  <button class="rounded-md p-1 hover:bg-accent xl:hidden" onclick={closeRun}>
                    <ArrowLeft class="h-4 w-4" />
                  </button>
                  <h3 class="text-lg font-semibold">{run.name}</h3>
                </div>
                <p class="mt-1 text-sm text-muted-foreground">{run.workflowPath || 'Workflow run'}</p>
              </div>
              <span class={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-medium ${getStatusBadge(run.status)}`}>
                {#if run.status === 'running' || run.status === 'in_progress'}
                  <RotateCw class="h-3.5 w-3.5 animate-spin" />
                {:else}
                  <StatusIcon class="h-3.5 w-3.5" />
                {/if}
                {statusLabel(run.status)}
              </span>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <button
                class="inline-flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:bg-accent"
                onclick={openRerunForm}>
                <Play class="h-4 w-4" />
                Prepare rerun
              </button>
              {#if rerunDraft}
                <button
                  class="rounded-md border border-input px-3 py-2 text-sm hover:bg-accent"
                  onclick={() => {
                    rerunDraft = null;
                    submissionMode = null;
                  }}>
                  Cancel
                </button>
              {/if}
            </div>

            {#if rerunDraft}
              <RunSubmissionForm
                title="Manual rerun"
                description="This reuses the prior workflow metadata and loom command, but needs a fresh payment token and any secrets that were previously encrypted."
                {submissionMode}
                bind:rerunDraft
                bind:rerunCommandMode
                bind:rerunArgsText
                bind:rerunPaymentToken
                bind:rerunSecrets
                bind:selectedMint
                bind:paymentAmount
                bind:runnerScriptTemplate
                bind:runnerScriptAutoManaged
                {rerunSubmitting}
                {discoveredWorkers}
                {loadingWorkers}
                {walletAvailable}
                {walletLoading}
                {walletError}
                {walletTotalBalance}
                {walletBalancesByMint}
                {visibleMintOptions}
                {generatingPaymentToken}
                {autoTokenPromptOpen}
                {selectedWorker}
                {compatibleMints}
                {signerError}
                {canGenerateSuggestedToken}
                {suggestedPaymentAmount}
                onRefreshWorkers={() => void refreshWorkers()}
                onRefreshWallet={() => void refreshWallet()}
                onGeneratePaymentToken={() => void generatePaymentToken()}
                onConfirmAutoTokenGeneration={() => void confirmAutoTokenGeneration()}
                onDismissAutoTokenGeneration={dismissAutoTokenGeneration}
                onAddRerunSecret={addRerunSecret}
                onRemoveRerunSecret={removeRerunSecret}
                onSetRerunCommandMode={mode => {
                  rerunCommandMode = mode
                  if (mode === 'reuse') {
                    runnerScriptAutoManaged = false
                  } else {
                    runnerScriptAutoManaged = true
                    runnerScriptTemplate = buildRunnerScriptTemplate(
                      rerunDraft.workflowPath,
                      selectedWorker,
                      rerunDraft.branch,
                    )
                  }
                }}
                onRegenerateTemplate={() => {
                  runnerScriptAutoManaged = true
                  runnerScriptTemplate = buildRunnerScriptTemplate(
                    rerunDraft.workflowPath,
                    selectedWorker,
                    rerunDraft.branch,
                  )
                }}
                onSubmit={() => void submitRerunRequest()}
                onConnectSigner={() => void connectSigner()} />
            {/if}

            <div class="grid gap-3 sm:grid-cols-2">
              <div class="rounded-md border border-border p-3">
                <div class="text-xs text-muted-foreground">Run ID</div>
                <div class="mt-1 break-all font-mono text-sm">{run.id}</div>
              </div>
              <div class="rounded-md border border-border p-3">
                <div class="text-xs text-muted-foreground">Commit</div>
                <div class="mt-1 break-all font-mono text-sm">{run.commit || '—'}</div>
              </div>
              <div class="rounded-md border border-border p-3">
                <div class="text-xs text-muted-foreground">Branch</div>
                <div class="mt-1 text-sm">{run.branch}</div>
              </div>
              <div class="rounded-md border border-border p-3">
                <div class="text-xs text-muted-foreground">Triggered by</div>
                <div class="mt-1 break-all font-mono text-sm">{run.actor}</div>
              </div>
              <div class="rounded-md border border-border p-3">
                <div class="text-xs text-muted-foreground">Created</div>
                <div class="mt-1 text-sm">{formatTimeAgo(run.createdAt)}</div>
              </div>
              <div class="rounded-md border border-border p-3">
                <div class="text-xs text-muted-foreground">Duration</div>
                <div class="mt-1 text-sm">{formatDuration(run.duration)}</div>
              </div>
            </div>

            {#if selectedRunDetail.worker}
              <div class="rounded-md border border-border p-3">
                <div class="mb-2 flex items-center gap-2 text-sm font-medium">
                  <Server class="h-4 w-4 text-primary" />
                  Worker
                </div>
                <div class="text-sm">{selectedRunDetail.worker.name}</div>
                <div class="mt-1 break-all text-xs text-muted-foreground">{selectedRunDetail.worker.pubkey}</div>
                <div class="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  {#if selectedRunDetail.worker.architecture}<span>{selectedRunDetail.worker.architecture}</span>{/if}
                  {#if selectedRunDetail.worker.actVersion}<span>act {selectedRunDetail.worker.actVersion}</span>{/if}
                  {#if selectedRunDetail.worker.pricing?.perSecondRate}<span>{selectedRunDetail.worker.pricing.perSecondRate} {selectedRunDetail.worker.pricing.unit || 'sat'}/s</span>{/if}
                  <span>{selectedRunDetail.worker.online ? 'online' : 'offline'}</span>
                </div>
              </div>
            {/if}

            <div class="space-y-3">
              {#each [
                { label: 'Workflow run', event: run.runEvent },
                { label: 'Workflow result', event: run.workflowLogEvent },
                { label: 'Loom job', event: run.loomJobEvent },
                { label: 'Loom status', event: run.loomStatusEvent },
                { label: 'Loom result', event: run.loomResultEvent },
              ] as block (block.label)}
                <div class="rounded-md border border-border p-3">
                  <div class="flex items-center justify-between gap-3">
                    <div class="text-sm font-medium">{block.label}</div>
                    {#if block.event}
                      <a
                        class="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        href={publicLinkForRun(block.event.id)}
                        target="_blank"
                        rel="noreferrer">
                        Open
                        <ExternalLink class="h-3 w-3" />
                      </a>
                    {/if}
                  </div>
                  <div class="mt-2 text-xs text-muted-foreground">{eventSummary(block.event)}</div>
                  {#if block.event}
                    <div class="mt-2 break-all font-mono text-xs">{block.event.id}</div>
                    {#if eventERefs(block.event).length > 0}
                      <div class="mt-2 text-xs text-muted-foreground">refs: {eventERefs(block.event).join(', ')}</div>
                    {/if}
                    {#if externalUrlForEvent(block.event)}
                      <a
                        class="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                        href={externalUrlForEvent(block.event)}
                        target="_blank"
                        rel="noreferrer">
                        View attached output
                        <ExternalLink class="h-3 w-3" />
                      </a>
                    {/if}
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {:else}
          {#if rerunDraft}
            <div class="space-y-4">
              <div>
                <h3 class="text-lg font-semibold">
                  {submissionMode === 'new' ? 'New workflow run' : 'Manual rerun'}
                </h3>
                <p class="mt-1 text-sm text-muted-foreground">
                  {submissionMode === 'new'
                    ? 'Create a new Hive CI run directly from the widget.'
                    : 'Reuse a prior run with a fresh payment token and secrets.'}
                </p>
              </div>

              <RunSubmissionForm
                title={submissionMode === 'new' ? 'New workflow run' : 'Manual rerun'}
                description={submissionMode === 'new'
                  ? 'Create a new Hive CI run directly from the widget.'
                  : 'Reuse a prior run with a fresh payment token and secrets.'}
                {submissionMode}
                bind:rerunDraft
                bind:rerunCommandMode
                bind:rerunArgsText
                bind:rerunPaymentToken
                bind:rerunSecrets
                bind:selectedMint
                bind:paymentAmount
                bind:runnerScriptTemplate
                bind:runnerScriptAutoManaged
                {rerunSubmitting}
                {discoveredWorkers}
                {loadingWorkers}
                {walletAvailable}
                {walletLoading}
                {walletError}
                {walletTotalBalance}
                {walletBalancesByMint}
                {visibleMintOptions}
                {generatingPaymentToken}
                {autoTokenPromptOpen}
                {selectedWorker}
                {compatibleMints}
                {signerError}
                {canGenerateSuggestedToken}
                {suggestedPaymentAmount}
                onRefreshWorkers={() => void refreshWorkers()}
                onRefreshWallet={() => void refreshWallet()}
                onGeneratePaymentToken={() => void generatePaymentToken()}
                onConfirmAutoTokenGeneration={() => void confirmAutoTokenGeneration()}
                onDismissAutoTokenGeneration={dismissAutoTokenGeneration}
                onAddRerunSecret={addRerunSecret}
                onRemoveRerunSecret={removeRerunSecret}
                onSetRerunCommandMode={mode => {
                  rerunCommandMode = mode
                  if (mode === 'reuse') {
                    runnerScriptAutoManaged = false
                  } else {
                    runnerScriptAutoManaged = true
                    runnerScriptTemplate = buildRunnerScriptTemplate(
                      rerunDraft.workflowPath,
                      selectedWorker,
                      rerunDraft.branch,
                    )
                  }
                }}
                onRegenerateTemplate={() => {
                  runnerScriptAutoManaged = true
                  runnerScriptTemplate = buildRunnerScriptTemplate(
                    rerunDraft.workflowPath,
                    selectedWorker,
                    rerunDraft.branch,
                  )
                }}
                onSubmit={() => void submitRerunRequest()}
                onConnectSigner={() => void connectSigner()} />
            </div>
          {:else}
            <div class="flex min-h-[320px] flex-col items-center justify-center text-center text-muted-foreground">
              <Workflow class="mb-3 h-8 w-8" />
              <p class="text-sm">Select a pipeline run to inspect the Hive CI event chain.</p>
            </div>
          {/if}
        {/if}
      </aside>
    </div>
  </div>
</div>
