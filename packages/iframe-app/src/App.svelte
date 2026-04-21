<script lang="ts">
  import {untrack} from 'svelte'
  import type {WidgetBridge} from '@flotilla/ext-shared'
  import {
    AlertCircle,
    ArrowLeft,
    ChevronRight,
    Clock,
    Copy,
    ExternalLink,
    Filter,
    GitBranch,
    GitCommit,
    Play,
    RefreshCw,
    RotateCw,
    SearchX,
    Server,
    Terminal,
  } from '@lucide/svelte'
  import {friendlyErrorMessage, normalizeRepo} from './lib/context'
  import {
    eventERefs,
    eventSummary,
    eventTagValue,
    externalUrlForEvent,
    mergeEventIntoDetail,
    mergeEventIntoRuns,
    publicLinkForRun,
    statusLabel,
  } from './lib/pipelines'
  import {
    buildAutoTokenCandidateKey,
    formatDuration,
    formatTimeAgo,
    getStatusBadge,
    getStatusColor,
    getStatusIcon,
    shortId,
    suggestedPaymentAmount,
  } from './lib/presentation'
  import {reconcileAutoTokenPrompt, reconcileWalletSelection} from './lib/wallet-prompt'
  import {
    canGenerateSuggestedToken as canGenerateSuggestedTokenValue,
    getCompatibleMints,
    getSelectedWorker,
    getVisibleMintOptions,
  } from './lib/submission'
  import RunSubmissionForm from './lib/components/RunSubmissionForm.svelte'
  import ConsoleOutput from './lib/components/ConsoleOutput.svelte'
  import WorkflowJobs from './lib/components/WorkflowJobs.svelte'
  import WorkflowLogs from './lib/components/WorkflowLogs.svelte'
  import {loadRunDetailController, refreshRunsController} from './lib/controllers'
  import {
    createSubmissionResetState,
    prepareNewRunSubmissionState,
    prepareRerunSubmissionState,
  } from './lib/submission-state'
  import {
    createClosedDetailSessionState,
    createDetailSessionErrorState,
    createOpenedDetailSessionState,
    createOpeningDetailSessionState,
    reconcileSelectedRunState,
  } from './lib/detail-session'
  import {setupWidgetLifecycle} from './lib/widget-lifecycle'
  import {attachSubscriptionListener, subscribe, unsubscribe, unsubscribeAll} from './lib/subscriptions'
  import {
    generatePaymentTokenViewModel,
    refreshWalletViewModel,
    refreshWorkersViewModel,
    submitRunViewModel,
  } from './lib/view-model'
  import {buildRunnerScriptTemplate} from './lib/runner-script'
  import {loadRepoMetadata} from './lib/repo'
  import {getJobGroups, parseActLog, parseWorkflowJobsFromYaml} from './lib/cicd'
  import {parseCashuTokenAmount} from './lib/payment'
  import type {
    RepoBranchInfo,
    RepoContext,
    RepoContextNormalized,
    RerunDraft,
    LoomWorker,
    WorkflowDefinition,
    WorkflowRun,
    WorkflowRunDetail,
  } from './lib/types'

  let bridge = $state<WidgetBridge | null>(null)
  let repoCtx = $state<RepoContext | null>(null)
  let repo = $derived(normalizeRepo(repoCtx))

  let loading = $state(false)
  let error = $state<string | null>(null)
  let workflowRuns = $state<WorkflowRun[]>([])

  let detailLoading = $state(false)
  let detailRefreshing = $state(false)
  let detailError = $state<string | null>(null)
  let selectedRunId = $state<string | null>(null)
  let selectedRunDetail = $state<WorkflowRunDetail | null>(null)

  let signerPubkey = $state<string | null>(null)
  let signerError = $state<string | null>(null)

  let rerunDraft = $state<RerunDraft | null>(null)
  let submissionMode = $state<'new' | 'rerun' | null>(null)
  let rerunArgsText = $state('')
  let rerunPaymentToken = $state('')
  let rerunSecrets = $state([{key: '', value: ''}])
  let rerunSubmitting = $state(false)
  let rerunCommandMode = $state<'reuse' | 'regenerate'>('reuse')
  let maxDuration = $state(600)

  let discoveredWorkers = $state<LoomWorker[]>([])
  let loadingWorkers = $state(false)
  let walletAvailable = $state(false)
  let walletLoading = $state(false)
  let walletError = $state<string | null>(null)
  let walletTotalBalance = $state(0)
  let walletBalancesByMint = $state<Record<string, number>>({})
  let walletMints = $state<string[]>([])
  let selectedMint = $state('')
  let paymentAmount = $state(100)
  let generatingPaymentToken = $state(false)
  let autoTokenPromptOpen = $state(false)
  let autoTokenPromptKey = $state('')
  let autoTokenDismissedKey = $state('')

  let runnerScriptTemplate = $state('')
  let runnerScriptAutoManaged = $state(true)

  let repoWorkflows = $state<WorkflowDefinition[]>([])
  let repoBranches = $state<RepoBranchInfo[]>([])
  let defaultBranch = $state('main')
  let repoMetadataLoading = $state(false)
  let repoMetadataError = $state<string | null>(null)

  let workflowJobsLoading = $state(false)
  let workflowJobsError = $state<string | null>(null)
  let workflowJobs = $state<ReturnType<typeof parseWorkflowJobsFromYaml>>([])
  let actLogContent = $state('')
  let actLogError = $state<string | null>(null)
  let loomStdout = $state('')
  let loomStderr = $state('')
  let loomStdoutUrl = $state<string | null>(null)
  let loomStderrUrl = $state<string | null>(null)
  let prepaidAmount = $state<number | null>(null)
  let changeAmount = $state<number | null>(null)

  let searchTerm = $state('')
  let statusFilter = $state<string>('all')
  let showFilters = $state(false)
  let showRawEvents = $state(false)

  let loadSeq = 0
  let detailSeq = 0

  const ACTIVE_RUN_STATUSES = ['pending', 'queued', 'running', 'in_progress'] as const
  const FALLBACK_RELAYS = ['wss://relay.sharegap.net', 'wss://nos.lol']

  let runListSubId = $state<string | null>(null)
  let runDetailSubId = $state<string | null>(null)
  let liveDurationSeconds = $state<number | null>(null)
  let subListenerCleanup: (() => void) | null = null

  const selectedWorker = $derived(getSelectedWorker(rerunDraft, discoveredWorkers))
  const compatibleMints = $derived.by(() => getCompatibleMints(selectedWorker, walletMints))
  const visibleMintOptions = $derived(getVisibleMintOptions(compatibleMints, walletMints))
  const canGenerateSuggestedToken = $derived(
    canGenerateSuggestedTokenValue({
      walletAvailable,
      selectedMint,
      paymentAmount,
      walletBalancesByMint,
    }),
  )
  const autoTokenCandidateKey = $derived.by(() =>
    buildAutoTokenCandidateKey({
      draft: rerunDraft,
      selectedWorker,
      selectedMint,
      canGenerateSuggestedToken,
      rerunPaymentToken,
      submissionMode,
      paymentAmount,
    }),
  )
  const availableBranches = $derived(repoBranches.map(branch => branch.name))
  const parsedActJobs = $derived(parseActLog(actLogContent))
  const actJobByName = $derived(new Map(parsedActJobs.map(job => [job.name.toLowerCase(), job])))
  const jobGroups = $derived(getJobGroups(workflowJobs))
  const runFinished = $derived(
    !!selectedRunDetail && !isActiveRunStatus(selectedRunDetail.run.status),
  )
  const actualCost = $derived(prepaidAmount !== null ? prepaidAmount - (changeAmount ?? 0) : null)

  async function showToast(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info') {
    if (!bridge) return

    try {
      await bridge.request('ui:toast', {message, type})
    } catch {
      // pass
    }
  }

  function isActiveRunStatus(status: string | undefined): boolean {
    return !!status && ACTIVE_RUN_STATUSES.includes(status as (typeof ACTIVE_RUN_STATUSES)[number])
  }

  async function copyText(value: string | undefined, label: string) {
    if (!value) return

    try {
      await navigator.clipboard.writeText(value)
      await showToast(`${label} copied`, 'success')
    } catch {
      await showToast(`Unable to copy ${label.toLowerCase()}`, 'error')
    }
  }

  function resetDetailArtifacts() {
    workflowJobsLoading = false
    workflowJobsError = null
    workflowJobs = []
    actLogContent = ''
    actLogError = null
    loomStdout = ''
    loomStderr = ''
    loomStdoutUrl = null
    loomStderrUrl = null
    prepaidAmount = null
    changeAmount = null
    showRawEvents = false
  }

  function applyDetailSessionState(nextState: ReturnType<typeof createClosedDetailSessionState>) {
    selectedRunId = nextState.selectedRunId
    selectedRunDetail = nextState.selectedRunDetail
    detailError = nextState.detailError
    detailLoading = nextState.detailLoading
    detailRefreshing = false
    if (!nextState.selectedRunDetail) {
      resetDetailArtifacts()
    }
  }

  async function refreshRuns(nextRepo: RepoContextNormalized | null = repo, background = false) {
    if (!bridge || !nextRepo) return

    const seq = ++loadSeq
    if (!background) {
      loading = true
      error = null
    }

    try {
      const nextRuns = await refreshRunsController(bridge, nextRepo)
      if (seq !== loadSeq) return
      workflowRuns = nextRuns
      const nextSelection = reconcileSelectedRunState({
        workflowRuns: nextRuns,
        selectedRunId,
        selectedRunDetail,
      })
      selectedRunId = nextSelection.selectedRunId
      selectedRunDetail = nextSelection.selectedRunDetail
      if (background) {
      }
    } catch (err) {
      if (seq !== loadSeq) return
      if (!background) {
        error = friendlyErrorMessage(err instanceof Error ? err.message : String(err))
      } else {
        console.warn('[pipelines] background refreshRuns failed', err)
      }
    } finally {
      if (seq === loadSeq && !background) loading = false
    }
  }

  async function refreshSelectedRun(background = false) {
    if (!bridge || !repo || !selectedRunId) return

    const seq = ++detailSeq
    if (background) {
      detailRefreshing = true
    }

    try {
      const detail = await loadRunDetailController(bridge, repo, selectedRunId)
      if (seq !== detailSeq) return

      applyDetailSessionState(createOpenedDetailSessionState(detail))
      if (detail?.run) {
        workflowRuns = workflowRuns.map(run => (run.id === detail.run.id ? {...run, ...detail.run} : run))
      }
    } catch (err) {
      if (seq !== detailSeq) return
      if (!background) {
        applyDetailSessionState(
          createDetailSessionErrorState(
            selectedRunId,
            friendlyErrorMessage(err instanceof Error ? err.message : String(err)),
          ),
        )
      } else {
        detailRefreshing = false
        console.warn('[pipelines] background refreshSelectedRun failed', err)
      }
    } finally {
      if (seq === detailSeq && background) {
        detailRefreshing = false
      }
    }
  }

  async function refreshRepoMetadata() {
    if (!bridge || !repo) return

    repoMetadataLoading = true
    repoMetadataError = null

    try {
      const metadata = await loadRepoMetadata(bridge)
      repoWorkflows = metadata.workflows
      repoBranches = metadata.branches
      defaultBranch = metadata.selectedBranch || metadata.defaultBranch || 'main'
    } catch (err) {
      repoMetadataError = friendlyErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      repoMetadataLoading = false
    }
  }

  async function openRun(run: WorkflowRun) {
    if (!bridge || !repo) return

    const seq = ++detailSeq
    applyDetailSessionState(createOpeningDetailSessionState(run))

    try {
      const detail = await loadRunDetailController(bridge, repo, run.id)
      if (seq !== detailSeq) return
      applyDetailSessionState(createOpenedDetailSessionState(detail))
    } catch (err) {
      if (seq !== detailSeq) return
      applyDetailSessionState(
        createDetailSessionErrorState(
          run.id,
          friendlyErrorMessage(err instanceof Error ? err.message : String(err)),
        ),
      )
    }
  }

  function applySubmissionState(nextState: ReturnType<typeof createSubmissionResetState>) {
    rerunDraft = nextState.rerunDraft
    submissionMode = nextState.submissionMode
    rerunArgsText = nextState.rerunArgsText
    rerunPaymentToken = nextState.rerunPaymentToken
    rerunSecrets = nextState.rerunSecrets
    rerunCommandMode = nextState.rerunCommandMode
    runnerScriptTemplate = nextState.runnerScriptTemplate
    runnerScriptAutoManaged = nextState.runnerScriptAutoManaged
    autoTokenPromptOpen = nextState.autoTokenPromptOpen
    autoTokenPromptKey = nextState.autoTokenPromptKey
    autoTokenDismissedKey = nextState.autoTokenDismissedKey
  }

  function applySubmissionReset() {
    applySubmissionState(createSubmissionResetState())
    maxDuration = 600
  }

  function applyWalletState(nextState: {
    walletAvailable: boolean
    walletTotalBalance: number
    walletBalancesByMint: Record<string, number>
    walletMints: string[]
    selectedMint: string
  }) {
    walletAvailable = nextState.walletAvailable
    walletTotalBalance = nextState.walletTotalBalance
    walletBalancesByMint = nextState.walletBalancesByMint
    walletMints = nextState.walletMints
    selectedMint = nextState.selectedMint
  }

  function applyAutoTokenPromptState(nextState: {autoTokenPromptOpen: boolean; autoTokenPromptKey: string}) {
    autoTokenPromptOpen = nextState.autoTokenPromptOpen
    autoTokenPromptKey = nextState.autoTokenPromptKey
  }

  function closeRun() {
    applyDetailSessionState(createClosedDetailSessionState())
    applySubmissionReset()
  }

  function resetFilters() {
    statusFilter = 'all'
    searchTerm = ''
  }

  function addRerunSecret() {
    rerunSecrets = [...rerunSecrets, {key: '', value: ''}]
  }

  function removeRerunSecret(index: number) {
    rerunSecrets = rerunSecrets.filter((_, currentIndex) => currentIndex !== index)
  }



  async function refreshWorkers() {
    if (!bridge || !repo) return

    loadingWorkers = true
    try {
      const nextState = await refreshWorkersViewModel({
        bridge,
        repo,
        rerunDraft,
      })
      discoveredWorkers = nextState.discoveredWorkers
      rerunDraft = nextState.rerunDraft
    } catch (err) {
      signerError = friendlyErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      loadingWorkers = false
    }
  }

  async function refreshWallet() {
    if (!bridge) return

    walletLoading = true
    walletError = null

    try {
      const nextState = await refreshWalletViewModel({bridge, selectedMint})
      applyWalletState(nextState)
    } catch (err) {
      walletAvailable = false
      walletError = friendlyErrorMessage(err instanceof Error ? err.message : String(err))
    } finally {
      walletLoading = false
    }
  }

  async function generatePaymentToken() {
    if (!bridge) return

    generatingPaymentToken = true
    walletError = null

    try {
      const nextState = await generatePaymentTokenViewModel({
        bridge,
        paymentAmount,
        selectedMint,
        submissionMode,
      })
      rerunPaymentToken = nextState.rerunPaymentToken
      applyWalletState(nextState)
      await showToast('Generated Cashu payment token', 'success')
    } catch (err) {
      walletError = friendlyErrorMessage(err instanceof Error ? err.message : String(err))
      await showToast(walletError, 'error')
      autoTokenDismissedKey = ''
    } finally {
      generatingPaymentToken = false
    }
  }

  async function confirmAutoTokenGeneration() {
    autoTokenPromptOpen = false
    autoTokenDismissedKey = autoTokenPromptKey
    await generatePaymentToken()
  }

  function dismissAutoTokenGeneration() {
    autoTokenPromptOpen = false
    autoTokenDismissedKey = autoTokenPromptKey
  }

  function openNewRunForm() {
    if (!repo) return

    const nextState = prepareNewRunSubmissionState(repo)
    if (!nextState) return

    applyDetailSessionState(createClosedDetailSessionState())
    signerError = null
    applySubmissionState(nextState)
    maxDuration = 600

    if (repoWorkflows.length > 0 && nextState.rerunDraft.workflowPath === '') {
      rerunDraft = {...nextState.rerunDraft, workflowPath: repoWorkflows[0].path}
    }

    const nextBranch = defaultBranch || availableBranches[0] || 'main'
    if (rerunDraft && (!rerunDraft.branch || rerunDraft.branch === 'main')) {
      rerunDraft = {...(rerunDraft || nextState.rerunDraft), branch: nextBranch}
    }

    void refreshWorkers()
    void refreshWallet()
    void refreshRepoMetadata()
  }

  function openRerunForm() {
    if (!repo || !selectedRunDetail) return

    const nextState = prepareRerunSubmissionState({repo, runDetail: selectedRunDetail})
    if (!nextState) {
      signerError = 'This run does not include enough loom job metadata to prepare a rerun inside the widget.'
      return
    }

    signerError = null
    applySubmissionState(nextState)
    maxDuration = selectedRunDetail.worker?.maxDuration || 600
    void refreshWorkers()
    void refreshWallet()
  }

  async function submitRerunRequest() {
    if (!signerPubkey) {
      signerError = 'Not signed in. The host must provide user context.'
      return
    }

    if (!bridge || !repo || !rerunDraft) {
      signerError = 'Missing required context to submit run. Please try refreshing the page.'
      return
    }

    rerunSubmitting = true
    signerError = null

    try {
      const nextState = await submitRunViewModel({
        bridge,
        repo,
        signerPubkey,
        submissionMode,
        rerunCommandMode,
        rerunDraft,
        rerunArgsText,
        rerunPaymentToken,
        runnerScriptTemplate,
        rerunSecrets,
      })

      applySubmissionReset()
      workflowRuns = nextState.workflowRuns
      applyDetailSessionState(nextState.detailSessionState)

      await showToast(`${submissionMode === 'new' ? 'Run' : 'Rerun'} submitted: ${nextState.runId.slice(0, 8)}`, 'success')
    } catch (err) {
      signerError = friendlyErrorMessage(err instanceof Error ? err.message : String(err))
      await showToast(signerError, 'error')
    } finally {
      rerunSubmitting = false
    }
  }

  async function fetchText(url: string): Promise<string> {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`)
    }
    return response.text()
  }

  const filteredRuns = $derived.by(() =>
    workflowRuns.filter(run => {
      if (searchTerm) {
        const query = searchTerm.toLowerCase()
        const fields = [run.name, run.branch, run.commitMessage, run.commit, run.actor, run.workflowPath || '']
        if (!fields.some(field => field.toLowerCase().includes(query))) return false
      }

      if (statusFilter !== 'all' && run.status !== statusFilter) return false
      return true
    }),
  )

  $effect(() => {
    if (!bridge) return
    void refreshWallet()
  })

  // Set signer pubkey from host-provided user pubkey
  $effect(() => {
    if (!repo?.userPubkey) return
    signerPubkey = repo.userPubkey
  })

  $effect(() => {
    if (!bridge || !repo) return
    void refreshRepoMetadata()
  })

  // Initial load + persistent subscription for run events
  $effect(() => {
    if (!bridge || !repo) return

    const currentBridge = bridge
    const currentRepo = repo

    // One-time initial load from relays
    void refreshRuns(currentRepo)

    // Open a persistent subscription — events are merged directly into state
    let subId: string | null = null
    const relays = [...new Set([...currentRepo.repoRelays, ...FALLBACK_RELAYS])]

    if (currentRepo.repoAddress) {
      void subscribe(currentBridge, relays, {
        kinds: [5401, 5100, 5402, 5101, 30100],
        '#a': [currentRepo.repoAddress],
        since: Math.floor(Date.now() / 1000) - 60,
      }, (event) => {
        // Merge the incoming event directly into the run list
        workflowRuns = mergeEventIntoRuns(workflowRuns, event, currentRepo.repoAddress)

        // Also update the selected detail if it matches
        const detail = selectedRunDetail
        if (detail) {
          const updated = mergeEventIntoDetail(detail, event)
          if (updated !== detail) {
            selectedRunDetail = updated
          }
        }
      }).then(id => {
        subId = id
        if (id) {
          runListSubId = id
        }
      })
    }

    return () => {
      if (subId) {
        runListSubId = null
        void unsubscribe(currentBridge, subId)
      }
    }
  })

  // Subscribe to detail-level events for the selected active run
  // Events are merged directly into selectedRunDetail by the run list subscription above.
  // This subscription adds a narrower #e filter to catch events that reference the run/job
  // by id but don't carry the repo #a tag.
  $effect(() => {
    if (!selectedRunId || !bridge || !repo) return

    const detail = untrack(() => selectedRunDetail)
    if (!detail || !isActiveRunStatus(detail.run.status)) return

    const currentBridge = bridge
    const currentRunId = selectedRunId
    const loomJobId = detail.run.loomJobEvent?.id

    const eTags = [currentRunId]
    if (loomJobId) eTags.push(loomJobId)

    const relays = [...new Set([...repo.repoRelays, ...FALLBACK_RELAYS])]

    let subId: string | null = null
    void subscribe(currentBridge, relays, {
      kinds: [5402, 5101, 30100],
      '#e': eTags,
      since: Math.floor(Date.now() / 1000) - 60,
    }, (event) => {
      // Merge into the detail
      const currentDetail = selectedRunDetail
      if (currentDetail) {
        const updated = mergeEventIntoDetail(currentDetail, event)
        if (updated !== currentDetail) {
          selectedRunDetail = updated
        }
      }
      // Also update the run in the list
      workflowRuns = mergeEventIntoRuns(workflowRuns, event)
    }).then(id => {
      subId = id
      if (id) {
        runDetailSubId = id
      }
    })

    return () => {
      if (subId) {
        runDetailSubId = null
        void unsubscribe(currentBridge, subId)
      }
    }
  })

  // Live duration counter for active runs
  // Re-run when selectedRunId changes (new selection) but read detail with untrack
  $effect(() => {
    if (!selectedRunId) {
      liveDurationSeconds = null
      return
    }

    const detail = untrack(() => selectedRunDetail)
    if (!detail || !isActiveRunStatus(detail.run.status)) {
      liveDurationSeconds = null
      return
    }

    const createdAt = detail.run.createdAt
    liveDurationSeconds = Math.floor((Date.now() - createdAt) / 1000)

    const interval = window.setInterval(() => {
      liveDurationSeconds = Math.floor((Date.now() - createdAt) / 1000)
    }, 1000)

    return () => window.clearInterval(interval)
  })

  $effect(() => {
    if (!rerunDraft || submissionMode !== 'new') return

    if (!rerunDraft.workflowPath && repoWorkflows.length > 0) {
      rerunDraft = {...rerunDraft, workflowPath: repoWorkflows[0].path}
    }

    if ((!rerunDraft.branch || rerunDraft.branch === 'main') && defaultBranch) {
      rerunDraft = {...rerunDraft, branch: defaultBranch}
    }
  })

  $effect(() => {
    const nextState = reconcileWalletSelection({
      selectedWorker,
      compatibleMints,
      walletBalancesByMint,
      selectedMint,
      rerunPaymentToken,
      paymentAmount,
    })

    if (nextState.selectedMint !== selectedMint) {
      selectedMint = nextState.selectedMint
    }

    if (nextState.paymentAmount !== paymentAmount) {
      paymentAmount = nextState.paymentAmount
    }
  })

  $effect(() => {
    const nextState = reconcileAutoTokenPrompt({
      autoTokenCandidateKey,
      autoTokenPromptKey,
      autoTokenDismissedKey,
      generatingPaymentToken,
    })

    if (
      nextState.autoTokenPromptOpen !== autoTokenPromptOpen ||
      nextState.autoTokenPromptKey !== autoTokenPromptKey
    ) {
      applyAutoTokenPromptState(nextState)
    }
  })

  $effect(() => {
    if (!rerunDraft || !runnerScriptAutoManaged) return
    if (submissionMode !== 'new' && !(submissionMode === 'rerun' && rerunCommandMode === 'regenerate')) {
      return
    }

    runnerScriptTemplate = buildRunnerScriptTemplate(rerunDraft.workflowPath, selectedWorker, rerunDraft.branch)
  })

  $effect(() => {
    if (!selectedRunDetail) {
      resetDetailArtifacts()
      return
    }

    const run = selectedRunDetail.run
    const paymentToken = eventTagValue(run.loomJobEvent, 'payment')
    const changeToken = eventTagValue(run.loomResultEvent, 'change')
    const logUrl = eventTagValue(run.workflowLogEvent, 'log_url')
    const stdoutUrl = eventTagValue(run.loomResultEvent, 'stdout')
    const stderrUrl = eventTagValue(run.loomResultEvent, 'stderr')

    prepaidAmount = null
    changeAmount = null
    loomStdout = ''
    loomStderr = ''
    loomStdoutUrl = stdoutUrl || null
    loomStderrUrl = stderrUrl || null
    actLogContent = ''
    actLogError = null
    workflowJobs = []
    workflowJobsError = null
    workflowJobsLoading = false

    if (paymentToken) {
      void parseCashuTokenAmount(paymentToken).then(amount => {
        prepaidAmount = amount
      }).catch(() => {
        prepaidAmount = null
      })
    }

    if (changeToken) {
      void parseCashuTokenAmount(changeToken).then(amount => {
        changeAmount = amount
      }).catch(() => {
        changeAmount = null
      })
    }

    if (stdoutUrl) {
      void fetchText(stdoutUrl).then(text => {
        loomStdout = text
      }).catch(err => {
        loomStdout = `Unable to load stdout: ${friendlyErrorMessage(err instanceof Error ? err.message : String(err))}`
      })
    }

    if (stderrUrl) {
      void fetchText(stderrUrl).then(text => {
        loomStderr = text
      }).catch(err => {
        loomStderr = `Unable to load stderr: ${friendlyErrorMessage(err instanceof Error ? err.message : String(err))}`
      })
    }

    if (logUrl) {
      void fetchText(logUrl).then(text => {
        actLogContent = text
      }).catch(err => {
        actLogError = friendlyErrorMessage(err instanceof Error ? err.message : String(err))
      })
    }

    if (run.workflowPath) {
      workflowJobsLoading = true
      const definition = repoWorkflows.find(workflow => workflow.path === run.workflowPath)
      if (definition?.content) {
        try {
          workflowJobs = parseWorkflowJobsFromYaml(definition.content)
        } catch (err) {
          workflowJobsError = friendlyErrorMessage(err instanceof Error ? err.message : String(err))
        } finally {
          workflowJobsLoading = false
        }
      } else {
        workflowJobsError = repoMetadataLoading
          ? 'Waiting for workflow definitions from the host…'
          : `Workflow definition not available for ${run.workflowPath}`
        workflowJobsLoading = false
      }
    }
  })

  $effect(() => {
    return setupWidgetLifecycle({
      onBridgeChange: nextBridge => {
        // Clean up old subscriptions
        // IMPORTANT: use untrack() to avoid reading 'bridge' as a tracked dependency
        // — setupWidgetLifecycle calls this callback synchronously, which would make
        // this effect depend on 'bridge', creating an infinite read→write→re-trigger cycle
        const oldBridge = untrack(() => bridge)
        if (oldBridge) {
          unsubscribeAll(oldBridge)
          subListenerCleanup = null
        }
        bridge = nextBridge
        // Attach subscription listener for the new bridge
        if (nextBridge) {
          subListenerCleanup = attachSubscriptionListener(nextBridge)
        }
      },
      onRepoContextChange: nextRepoCtx => {
        repoCtx = nextRepoCtx
      },
      onRefreshRuns: nextRepo => refreshRuns(nextRepo ?? repo),
      onRepoChange: () => {
        closeRun()
        repoWorkflows = []
        repoBranches = []
      },
      onUnmount: () => {
        loadSeq += 1
        detailSeq += 1
        workflowRuns = []
        repoWorkflows = []
        repoBranches = []
        const currentBridge = untrack(() => bridge)
        if (currentBridge) {
          unsubscribeAll(currentBridge)
          subListenerCleanup = null
        }
        closeRun()
      },
    })
  })
</script>

<div class="min-h-screen bg-background p-4 text-foreground">
  <div class="mx-auto max-w-7xl space-y-4">
    {#if !selectedRunId}
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div class="relative flex-1">
        <input
          class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
          bind:value={searchTerm}
          type="text"
          placeholder="Search runs, commits, branches, or actors…" />
      </div>
      <div class="flex items-center gap-2">
        <button class="rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent" onclick={() => (showFilters = !showFilters)}>
          <Filter class="h-4 w-4" />
        </button>
        <button class="inline-flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm hover:bg-accent" onclick={openNewRunForm}>
          <Play class="h-4 w-4" />
          New run
        </button>
      </div>
    </div>
    {#if repoMetadataError}
      <p class="text-xs text-yellow-400">Repo metadata: {repoMetadataError}</p>
    {/if}
    {/if}

    <div class="space-y-4">
      {#if !selectedRunId}
      <section class="space-y-4">

        {#if showFilters}
          <div class="rounded-lg border border-border bg-card p-4">
            <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <div class="space-y-2">
                <label for="status-filter" class="text-sm font-medium">Status</label>
                <select id="status-filter" bind:value={statusFilter} class="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground">
                  <option value="all">All statuses</option>
                  <option value="success">Success</option>
                  <option value="failure">Failure</option>
                  <option value="running">Running</option>
                  <option value="queued">Queued</option>
                  <option value="pending">Pending</option>
                </select>
              </div>
              <button class="rounded-md border border-input px-3 py-2 text-sm hover:bg-accent" onclick={resetFilters}>
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
              <button class={`group w-full rounded-lg border p-4 text-left transition-colors hover:bg-accent/40 ${selectedRunId === run.id ? 'border-primary/40 bg-card/95' : 'border-border bg-card'}`} onclick={() => void openRun(run)}>
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
                    {#if selectedRunId === run.id && detailRefreshing && isActiveRunStatus(run.status)}
                      <div class="text-xs text-sky-300">Refreshing live status…</div>
                    {/if}

                    <div class="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                      <div class="flex items-center gap-1">
                        <GitCommit class="h-3 w-3" />
                        <span class="font-mono">{shortId(run.commit || run.id, 7)}</span>
                      </div>
                      <div class="flex items-center gap-1">
                        <GitBranch class="h-3 w-3" />
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
              <div class="text-2xl font-bold text-yellow-400">{workflowRuns.filter(run => ['running', 'in_progress', 'queued', 'pending'].includes(run.status)).length}</div>
            </div>
          </div>
        </div>
      </section>
      {:else}
      <aside class="space-y-4 rounded-lg border border-border bg-card p-4">
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
                  <button class="inline-flex items-center gap-1 rounded-md border border-input bg-background px-2 py-1 text-sm hover:bg-accent" onclick={closeRun}>
                    <ArrowLeft class="h-4 w-4" />
                    Back
                  </button>
                  <h3 class="text-lg font-semibold">{run.name}</h3>
                </div>
                <p class="mt-1 text-sm text-muted-foreground">{run.workflowPath || 'Workflow run'}</p>
                {#if detailRefreshing && isActiveRunStatus(run.status)}
                  <p class="mt-1 text-xs text-sky-300">Refreshing active run…</p>
                {/if}
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

            {#if run.status === 'failure' && !run.workflowLogEvent && run.loomResultEvent}
              <p class="text-xs text-yellow-400">Error (workflow result event missing — status inferred from loom result)</p>
            {/if}

            {#if isActiveRunStatus(run.status) && liveDurationSeconds !== null}
              <div class="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock class="h-3.5 w-3.5" />
                <span>Running for {formatDuration(liveDurationSeconds)}</span>
              </div>
            {/if}

            <div class="flex flex-wrap items-center gap-2">
              <button class="inline-flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:bg-accent" onclick={() => void refreshSelectedRun(detailLoading || detailRefreshing)}>
                <RefreshCw class={`h-4 w-4 ${detailLoading || detailRefreshing ? 'animate-spin' : ''}`} />
                Refresh run
              </button>
              <button class="inline-flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:bg-accent" onclick={openRerunForm}>
                <Play class="h-4 w-4" />
                Prepare rerun
              </button>
              <a class="inline-flex items-center gap-2 rounded-md border border-input px-3 py-2 text-sm hover:bg-accent" href={publicLinkForRun(run.id)} target="_blank" rel="noreferrer">
                <ExternalLink class="h-4 w-4" />
                Open event
              </a>
              {#if rerunDraft}
                <button class="rounded-md border border-input px-3 py-2 text-sm hover:bg-accent" onclick={applySubmissionReset}>
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
                bind:maxDuration
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
                {availableBranches}
                {defaultBranch}
                availableWorkflows={repoWorkflows}
                suggestedPaymentAmount={suggestedPaymentAmount}
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
                  } else if (rerunDraft) {
                    runnerScriptAutoManaged = true
                    runnerScriptTemplate = buildRunnerScriptTemplate(rerunDraft.workflowPath, selectedWorker, rerunDraft.branch)
                  }
                }}
                onRegenerateTemplate={() => {
                  if (!rerunDraft) return
                  runnerScriptAutoManaged = true
                  runnerScriptTemplate = buildRunnerScriptTemplate(rerunDraft.workflowPath, selectedWorker, rerunDraft.branch)
                }}
                onSubmit={() => void submitRerunRequest()}
              />
            {/if}

            <div class="grid gap-3 sm:grid-cols-2">
              <div class="rounded-md border border-border p-3">
                <div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>Run ID</span>
                  <button class="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-accent" onclick={() => void copyText(run.id, 'Run ID')}>
                    <Copy class="h-3.5 w-3.5" />
                    Copy
                  </button>
                </div>
                <div class="mt-1 break-all font-mono text-sm">{run.id}</div>
              </div>
              <div class="rounded-md border border-border p-3">
                <div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>Commit</span>
                  {#if run.commit}
                    <button class="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-accent" onclick={() => void copyText(run.commit, 'Commit')}>
                      <Copy class="h-3.5 w-3.5" />
                      Copy
                    </button>
                  {/if}
                </div>
                <div class="mt-1 break-all font-mono text-sm">{run.commit || '—'}</div>
              </div>
              <div class="rounded-md border border-border p-3">
                <div class="text-xs text-muted-foreground">Branch</div>
                <div class="mt-1 text-sm">{run.branch}</div>
              </div>
              <div class="rounded-md border border-border p-3">
                <div class="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>Triggered by</span>
                  <button class="inline-flex items-center gap-1 rounded px-1.5 py-1 hover:bg-accent" onclick={() => void copyText(run.actor, 'Actor')}>
                    <Copy class="h-3.5 w-3.5" />
                    Copy
                  </button>
                </div>
                <div class="mt-1 break-all font-mono text-sm">{run.actor}</div>
              </div>
              <div class="rounded-md border border-border p-3">
                <div class="text-xs text-muted-foreground">Created</div>
                <div class="mt-1 text-sm">{formatTimeAgo(run.createdAt)}</div>
              </div>
              <div class="rounded-md border border-border p-3">
                <div class="text-xs text-muted-foreground">Duration</div>
                <div class="mt-1 text-sm">{isActiveRunStatus(run.status) && liveDurationSeconds !== null ? formatDuration(liveDurationSeconds) : formatDuration(run.duration)}</div>
              </div>
            </div>

            {#if selectedRunDetail.worker}
              <div class="rounded-md border border-border p-3">
                <div class="mb-2 flex items-center justify-between gap-2 text-sm font-medium">
                  <div class="flex items-center gap-2">
                    <Server class="h-4 w-4 text-primary" />
                    Worker
                  </div>
                  <div class="flex items-center gap-2">
                    <button class="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs hover:bg-accent" onclick={() => void copyText(selectedRunDetail.worker?.pubkey, 'Worker pubkey')}>
                      <Copy class="h-3.5 w-3.5" />
                      Copy
                    </button>
                    <a class="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs hover:bg-accent" href={`nostr:${selectedRunDetail.worker.pubkey}`} target="_blank" rel="noreferrer">
                      <ExternalLink class="h-3.5 w-3.5" />
                      Open
                    </a>
                  </div>
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

            <div class="grid gap-3 sm:grid-cols-3">
              <div class="rounded-md border border-border p-3">
                <div class="text-xs text-muted-foreground">Prepaid</div>
                <div class="mt-1 text-lg font-semibold">{prepaidAmount !== null ? `${prepaidAmount.toLocaleString()} sats` : '—'}</div>
              </div>
              <div class="rounded-md border border-border p-3">
                <div class="text-xs text-muted-foreground">Change</div>
                <div class="mt-1 text-lg font-semibold">{changeAmount !== null ? `${changeAmount.toLocaleString()} sats` : '—'}</div>
              </div>
              <div class="rounded-md border border-border p-3">
                <div class="text-xs text-muted-foreground">Actual cost</div>
                <div class="mt-1 text-lg font-semibold">{actualCost !== null ? `${actualCost.toLocaleString()} sats` : '—'}</div>
              </div>
            </div>

            <WorkflowJobs workflowJobs={workflowJobs} {jobGroups} loading={workflowJobsLoading} error={workflowJobsError} {actJobByName} />

            {#if parsedActJobs.length > 0}
              <WorkflowLogs parsedActJobs={parsedActJobs} {jobGroups} {runFinished} />
            {/if}

            {#if actLogError}
              <div class="rounded-md border border-yellow-500/20 bg-yellow-500/10 p-3 text-xs text-yellow-200">{actLogError}</div>
            {/if}

            <div class="grid gap-3 lg:grid-cols-2">
              <ConsoleOutput title="Workflow act log" content={actLogContent} url={eventTagValue(run.workflowLogEvent, 'log_url') || null} defaultLines={3} />
              <ConsoleOutput title="stdout (loom)" content={loomStdout} url={loomStdoutUrl} defaultLines={3} />
              <ConsoleOutput title="stderr (loom)" content={loomStderr} url={loomStderrUrl} defaultLines={3} variant="error" />
            </div>

            <div class="rounded-md border border-border p-3">
              <div class="mb-2 flex items-center justify-between">
                <div class="text-sm font-medium">Raw event chain</div>
                <button class="text-xs text-primary hover:underline" onclick={() => (showRawEvents = !showRawEvents)}>{showRawEvents ? 'Hide' : 'Show'}</button>
              </div>
              {#if showRawEvents}
                <div class="space-y-3">
                  {#each [
                    {label: 'Workflow run', event: run.runEvent},
                    {label: 'Workflow result', event: run.workflowLogEvent},
                    {label: 'Loom job', event: run.loomJobEvent},
                    {label: 'Loom status', event: run.loomStatusEvent},
                    {label: 'Loom result', event: run.loomResultEvent},
                  ] as block (block.label)}
                    <div class="rounded-md border border-border p-3">
                      <div class="flex items-center justify-between gap-3">
                        <div class="text-sm font-medium">{block.label}</div>
                        {#if block.event}
                          <div class="flex items-center gap-2">
                            <button class="inline-flex items-center gap-1 text-xs text-primary hover:underline" onclick={() => void copyText(block.event?.id, `${block.label} ID`)}>
                              <Copy class="h-3 w-3" />
                              Copy
                            </button>
                            <a class="inline-flex items-center gap-1 text-xs text-primary hover:underline" href={publicLinkForRun(block.event.id)} target="_blank" rel="noreferrer">
                              Open
                              <ExternalLink class="h-3 w-3" />
                            </a>
                          </div>
                        {/if}
                      </div>
                      <div class="mt-2 text-xs text-muted-foreground">{eventSummary(block.event)}</div>
                      {#if block.event}
                        <div class="mt-2 break-all font-mono text-xs">{block.event.id}</div>
                        {#if eventERefs(block.event).length > 0}
                          <div class="mt-2 text-xs text-muted-foreground">refs: {eventERefs(block.event).join(', ')}</div>
                        {/if}
                        {#if externalUrlForEvent(block.event)}
                          <a class="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline" href={externalUrlForEvent(block.event)} target="_blank" rel="noreferrer">
                            View attached output
                            <ExternalLink class="h-3 w-3" />
                          </a>
                        {/if}
                      {/if}
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        {:else if rerunDraft}
          <div class="space-y-4">
            <div>
              <h3 class="text-lg font-semibold">{submissionMode === 'new' ? 'New workflow run' : 'Manual rerun'}</h3>
              <p class="mt-1 text-sm text-muted-foreground">{submissionMode === 'new' ? 'Create a new Hive CI run using live workflow and branch data from this repo.' : 'Reuse a prior run with a fresh payment token and secrets.'}</p>
            </div>

            <RunSubmissionForm
              title={submissionMode === 'new' ? 'New workflow run' : 'Manual rerun'}
              description={submissionMode === 'new' ? 'Recreated from the original PR flow: workflow selection, worker pricing, wallet-aware mint selection, and generated runner script.' : 'Reuse a previous loom job with real worker discovery, wallet prompting, and regenerated runner script support.'}
              {submissionMode}
              bind:rerunDraft
              bind:rerunCommandMode
              bind:rerunArgsText
              bind:rerunPaymentToken
              bind:rerunSecrets
              bind:selectedMint
              bind:paymentAmount
              bind:maxDuration
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
              {availableBranches}
              {defaultBranch}
              availableWorkflows={repoWorkflows}
              suggestedPaymentAmount={suggestedPaymentAmount}
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
                } else if (rerunDraft) {
                  runnerScriptAutoManaged = true
                  runnerScriptTemplate = buildRunnerScriptTemplate(rerunDraft.workflowPath, selectedWorker, rerunDraft.branch)
                }
              }}
              onRegenerateTemplate={() => {
                if (!rerunDraft) return
                runnerScriptAutoManaged = true
                runnerScriptTemplate = buildRunnerScriptTemplate(rerunDraft.workflowPath, selectedWorker, rerunDraft.branch)
              }}
              onSubmit={() => void submitRerunRequest()}
            />
          </div>
        {:else}
          <div class="flex min-h-[320px] flex-col items-center justify-center text-center text-muted-foreground">
            <Terminal class="mb-3 h-8 w-8" />
            <p class="text-sm">Select a pipeline run to inspect the Hive CI event chain, parsed jobs, and loom outputs.</p>
          </div>
        {/if}
      </aside>
      {/if}
    </div>
  </div>
</div>
