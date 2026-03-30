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
  import { formatDistanceToNow } from 'date-fns';
  import { friendlyErrorMessage, getHostOrigin, normalizeRepo, transformHostContext } from './lib/context';
  import {
    eventERefs,
    eventSummary,
    externalUrlForEvent,
    buildRerunDraft,
    loadWorkers,
    loadWorkflowRunDetail,
    loadWorkflowRuns,
    publicLinkForRun,
    statusLabel,
  } from './lib/pipelines';
  import { connectNip07Signer, submitRerun, toRepoNostrUrl } from './lib/nip07';
  import { createCashuPaymentToken, loadCashuWalletState } from './lib/wallet';
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

  let searchTerm = $state('');
  let statusFilter = $state<string>('all');
  let showFilters = $state(false);

  let loadSeq = 0;
  let detailSeq = 0;

  function getStatusIcon(status: WorkflowStatus) {
    switch (status) {
      case 'success':
        return Check;
      case 'failure':
        return X;
      case 'running':
      case 'in_progress':
        return RotateCw;
      case 'queued':
      case 'pending':
        return Clock;
      case 'cancelled':
      case 'skipped':
      case 'unknown':
      default:
        return Circle;
    }
  }

  function getStatusColor(status: WorkflowStatus) {
    switch (status) {
      case 'success':
        return 'text-green-400';
      case 'failure':
        return 'text-red-400';
      case 'running':
      case 'in_progress':
        return 'text-yellow-400';
      case 'queued':
        return 'text-sky-400';
      case 'pending':
        return 'text-zinc-400';
      default:
        return 'text-zinc-400';
    }
  }

  function getStatusBadge(status: WorkflowStatus) {
    switch (status) {
      case 'success':
        return 'border-green-500/20 bg-green-500/10 text-green-300';
      case 'failure':
        return 'border-red-500/20 bg-red-500/10 text-red-300';
      case 'running':
      case 'in_progress':
        return 'border-yellow-500/20 bg-yellow-500/10 text-yellow-300';
      case 'queued':
        return 'border-sky-500/20 bg-sky-500/10 text-sky-300';
      case 'pending':
        return 'border-zinc-500/20 bg-zinc-500/10 text-zinc-300';
      default:
        return 'border-zinc-500/20 bg-zinc-500/10 text-zinc-300';
    }
  }

  function formatTimeAgo(timestamp: number) {
    return formatDistanceToNow(timestamp, { addSuffix: true });
  }

  function formatDuration(seconds?: number) {
    if (!seconds) return '—';
    if (seconds < 60) return `${seconds}s`;

    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  }

  function shortId(value?: string, size = 8) {
    return value ? value.slice(0, size) : '—';
  }

  function repoName(value: RepoContextNormalized | null) {
    return value?.repoName || 'Loading repository…';
  }

  const selectedWorker = $derived(
    rerunDraft?.workerPubkey
      ? discoveredWorkers.find(worker => worker.pubkey === rerunDraft?.workerPubkey) || null
      : null
  );

  const compatibleMints = $derived.by(() => {
    if (!selectedWorker) return walletMints;
    const workerMints = selectedWorker.mints || [];
    return walletMints.filter(mint => workerMints.includes(mint));
  });

  function suggestedPaymentAmount(worker: LoomWorker | null) {
    if (!worker?.pricing?.perSecondRate || !worker.minDuration) return 100;
    return Math.max(1, Math.ceil(worker.pricing.perSecondRate * worker.minDuration));
  }

  const canGenerateSuggestedToken = $derived(
    walletAvailable &&
      !!selectedMint &&
      paymentAmount > 0 &&
      (walletBalancesByMint[selectedMint] || 0) >= paymentAmount
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
      workflowRuns = await loadWorkflowRuns(bridge, nextRepo);
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
      selectedRunDetail = await loadWorkflowRunDetail(bridge, repo, run.id);
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
      discoveredWorkers = await loadWorkers(bridge, repo);
      if (rerunDraft && !rerunDraft.workerPubkey) {
        rerunDraft.workerPubkey = discoveredWorkers[0]?.pubkey || '';
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
      const state = await loadCashuWalletState(bridge);
      walletAvailable = true;
      walletTotalBalance = state.totalBalance;
      walletBalancesByMint = state.balancesByMint;
      walletMints = state.mints;

      if (!selectedMint || !state.mints.includes(selectedMint)) {
        selectedMint = state.mints[0] || '';
      }
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
      const token = await createCashuPaymentToken(
        bridge,
        paymentAmount,
        selectedMint,
        submissionMode === 'new' ? 'CI/CD pipeline runner' : 'CI/CD pipeline rerun'
      );
      rerunPaymentToken = token;
      await refreshWallet();
      await showToast('Generated Cashu payment token', 'success');
    } catch (err) {
      walletError = friendlyErrorMessage(err instanceof Error ? err.message : String(err));
      await showToast(walletError, 'error');
    } finally {
      generatingPaymentToken = false;
    }
  }

  $effect(() => {
    if (!bridge) return;
    void refreshWallet();
  });

  $effect(() => {
    if (!selectedWorker) return;

    const bestCompatibleMint =
      compatibleMints
        .slice()
        .sort((a, b) => (walletBalancesByMint[b] || 0) - (walletBalancesByMint[a] || 0))[0] || '';

    if (bestCompatibleMint && selectedMint !== bestCompatibleMint) {
      selectedMint = bestCompatibleMint;
    }

    const suggested = suggestedPaymentAmount(selectedWorker);
    if (!rerunPaymentToken && paymentAmount <= 0) {
      paymentAmount = suggested;
    } else if (!rerunPaymentToken && paymentAmount === 100) {
      paymentAmount = suggested;
    }
  });

  function openNewRunForm() {
    if (!repo?.repoNaddr) return;

    selectedRunId = null;
    selectedRunDetail = null;
    detailError = null;

    const publishRelays = Array.from(new Set([...repo.repoRelays, 'wss://relay.sharegap.net', 'wss://nos.lol']));
    rerunDraft = {
      repoNaddr: repo.repoNaddr,
      workflowPath: '',
      branch: 'main',
      commit: '',
      workerPubkey: '',
      command: 'bash',
      args: [
        '-c',
        'curl -fsSL "https://example.invalid/run-workflow.sh" -o /tmp/run-workflow.sh && chmod +x /tmp/run-workflow.sh && /tmp/run-workflow.sh',
      ],
      envVars: [],
      repoNostrUrl: toRepoNostrUrl(repo.repoNaddr, publishRelays),
      publishRelays,
    };
    rerunArgsText = rerunDraft.args.join('\n');
    rerunPaymentToken = '';
    rerunSecrets = [{ key: '', value: '' }];
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
      rerunDraft.args = rerunArgsText
        .split('\n')
        .map(value => value.trim())
        .filter(Boolean);

      const runId = await submitRerun(
        signerPubkey,
        rerunDraft,
        rerunPaymentToken.trim(),
        rerunSecrets
      );

      rerunDraft = null;
      submissionMode = null;
      rerunArgsText = '';
      rerunPaymentToken = '';
      rerunSecrets = [{ key: '', value: '' }];

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
              <div class="space-y-4 rounded-md border border-border bg-background/60 p-4">
                <div>
                  <h4 class="text-sm font-semibold">Manual rerun</h4>
                  <p class="mt-1 text-xs text-muted-foreground">
                    This reuses the prior workflow metadata and loom command, but needs a fresh
                    payment token and any secrets that were previously encrypted.
                  </p>
                </div>

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

                <label class="block space-y-1 text-sm">
                  <span class="text-xs text-muted-foreground">Fresh payment token</span>
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
                    <button class="text-xs text-primary hover:underline" onclick={addRerunSecret}>
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
                        onclick={() => removeRerunSecret(index)}>
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

                <div class="flex flex-wrap items-center gap-2">
                  <button
                    class="inline-flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm hover:bg-primary/20"
                    onclick={() => void submitRerunRequest()}
                    disabled={rerunSubmitting}>
                    <Play class={`h-4 w-4 ${rerunSubmitting ? 'animate-pulse' : ''}`} />
                    {rerunSubmitting ? 'Submitting…' : 'Submit rerun'}
                  </button>
                  {#if !signerPubkey}
                    <button
                      class="rounded-md border border-input px-3 py-2 text-sm hover:bg-accent"
                      onclick={() => void connectSigner()}>
                      Connect signer first
                    </button>
                  {/if}
                </div>
              </div>
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

              <div class="space-y-4 rounded-md border border-border bg-background/60 p-4">
                <div class="grid gap-3 sm:grid-cols-2">
                  <label class="space-y-1 text-sm">
                    <span class="text-xs text-muted-foreground">Workflow</span>
                    <input
                      class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      bind:value={rerunDraft.workflowPath} />
                  </label>
                  <label class="space-y-1 text-sm">
                    <span class="text-xs text-muted-foreground">Branch</span>
                    <input
                      class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      bind:value={rerunDraft.branch} />
                  </label>
                  <label class="space-y-1 text-sm sm:col-span-2">
                    <span class="text-xs text-muted-foreground">Commit</span>
                    <input
                      class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                      bind:value={rerunDraft.commit} />
                  </label>
                </div>

                <div class="space-y-2">
                  <div class="flex items-center justify-between">
                    <span class="text-xs text-muted-foreground">Worker discovery</span>
                    <button class="text-xs text-primary hover:underline" onclick={() => void refreshWorkers()}>
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
                              <div class="mt-1 break-all text-xs text-muted-foreground">
                                {worker.pubkey}
                              </div>
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
                  <input
                    class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    bind:value={rerunDraft.command} />
                </label>

                <label class="block space-y-1 text-sm">
                  <span class="text-xs text-muted-foreground">Arguments (one per line)</span>
                  <textarea
                    class="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-xs font-mono"
                    bind:value={rerunArgsText}></textarea>
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
                        {#each walletMints as mint}
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
                      <button
                        class="rounded-md border border-input px-3 py-2 text-sm hover:bg-accent"
                        onclick={() => void refreshWallet()}>
                        {walletLoading ? 'Loading…' : 'Refresh wallet'}
                      </button>
                      <button
                        class="rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm hover:bg-primary/20"
                        onclick={() => void generatePaymentToken()}
                        disabled={!walletAvailable || generatingPaymentToken}>
                        {generatingPaymentToken ? 'Generating…' : 'Generate token'}
                      </button>
                    </div>
                  </div>
                  <div class="text-xs text-muted-foreground">
                    {#if walletAvailable}
                      Wallet available. Total balance: {walletTotalBalance.toLocaleString()} sats.
                      {#if selectedWorker}
                        Compatible mints: {compatibleMints.length > 0
                          ? compatibleMints.join(', ')
                          : 'none from current wallet'}.
                        Suggested amount: {suggestedPaymentAmount(selectedWorker)} sats.
                      {/if}
                    {:else if walletError}
                      Wallet bridge unavailable: {walletError}
                    {:else}
                      Wallet bridge not yet checked.
                    {/if}
                  </div>
                  {#if walletAvailable}
                    <div class="flex flex-wrap items-center gap-2 text-xs">
                      <button
                        class="rounded-md border border-input px-2 py-1 hover:bg-accent disabled:opacity-50"
                        onclick={() => void generatePaymentToken()}
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

                {#if signerError}
                  <div class="rounded-md border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-200">
                    {signerError}
                  </div>
                {/if}

                <div class="flex flex-wrap items-center gap-2">
                  <button
                    class="inline-flex items-center gap-2 rounded-md border border-primary/30 bg-primary/10 px-3 py-2 text-sm hover:bg-primary/20"
                    onclick={() => void submitRerunRequest()}
                    disabled={rerunSubmitting}>
                    <Play class={`h-4 w-4 ${rerunSubmitting ? 'animate-pulse' : ''}`} />
                    {rerunSubmitting ? 'Submitting…' : 'Submit run'}
                  </button>
                  <button
                    class="rounded-md border border-input px-3 py-2 text-sm hover:bg-accent"
                    onclick={() => {
                      rerunDraft = null;
                      submissionMode = null;
                    }}>
                    Cancel
                  </button>
                </div>
              </div>
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
