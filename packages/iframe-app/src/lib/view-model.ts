import type { WidgetBridge } from '@flotilla/ext-shared';
import {
  generatePaymentTokenController,
  loadRunDetailController,
  refreshRunsController,
  refreshWalletController,
  refreshWorkersController,
  submitRunController,
} from './controllers';
import { createClosedDetailSessionState, createOpenedDetailSessionState } from './detail-session';
import type { DetailSessionState } from './detail-session';
import type { RepoContextNormalized, RerunDraft } from './types';

export async function refreshWorkersViewModel(args: {
  bridge: WidgetBridge;
  repo: RepoContextNormalized;
  rerunDraft: RerunDraft | null;
}) {
  const nextState = await refreshWorkersController(
    args.bridge,
    args.repo,
    args.rerunDraft?.workerPubkey
  );

  let updatedRerunDraft = args.rerunDraft;
  if (args.rerunDraft && !args.rerunDraft.workerPubkey && nextState.nextWorkerPubkey) {
    updatedRerunDraft = {
      ...args.rerunDraft,
      workerPubkey: nextState.nextWorkerPubkey,
    };
  }

  return {
    discoveredWorkers: nextState.workers,
    rerunDraft: updatedRerunDraft,
  };
}

export async function refreshWalletViewModel(args: { bridge: WidgetBridge; selectedMint: string }) {
  const state = await refreshWalletController(args.bridge, args.selectedMint);

  return {
    walletAvailable: true,
    walletTotalBalance: state.totalBalance,
    walletBalancesByMint: state.balancesByMint,
    walletMints: state.mints,
    selectedMint: state.nextSelectedMint,
  };
}

export async function generatePaymentTokenViewModel(args: {
  bridge: WidgetBridge;
  paymentAmount: number;
  selectedMint: string;
  submissionMode: 'new' | 'rerun' | null;
}) {
  if (!args.selectedMint) {
    throw new Error('Select a mint first.');
  }

  if (args.paymentAmount <= 0) {
    throw new Error('Payment amount must be greater than zero.');
  }

  const rerunPaymentToken = await generatePaymentTokenController(
    args.bridge,
    args.paymentAmount,
    args.selectedMint,
    args.submissionMode
  );

  const walletState = await refreshWalletViewModel({
    bridge: args.bridge,
    selectedMint: args.selectedMint,
  });

  return {
    rerunPaymentToken,
    ...walletState,
  };
}

export async function submitRunViewModel(args: {
  bridge: WidgetBridge;
  repo: RepoContextNormalized;
  signerPubkey: string;
  submissionMode: 'new' | 'rerun' | null;
  rerunCommandMode: 'reuse' | 'regenerate';
  rerunDraft: RerunDraft;
  rerunArgsText: string;
  rerunPaymentToken: string;
  runnerScriptTemplate: string;
  rerunSecrets: Array<{ key: string; value: string }>;
}) {
  const runId = await submitRunController({
    signerPubkey: args.signerPubkey,
    submissionMode: args.submissionMode,
    rerunCommandMode: args.rerunCommandMode,
    rerunDraft: args.rerunDraft,
    rerunArgsText: args.rerunArgsText,
    rerunPaymentToken: args.rerunPaymentToken,
    runnerScriptTemplate: args.runnerScriptTemplate,
    rerunSecrets: args.rerunSecrets,
  });

  const workflowRuns = await refreshRunsController(args.bridge, args.repo);
  const nextRun = workflowRuns.find((run) => run.id === runId);

  let detailSessionState: DetailSessionState = createClosedDetailSessionState();
  if (nextRun) {
    const detail = await loadRunDetailController(args.bridge, args.repo, nextRun.id);
    detailSessionState = createOpenedDetailSessionState(detail);
  }

  return {
    runId,
    workflowRuns,
    detailSessionState,
  };
}
