import { suggestedPaymentAmount } from './presentation';
import { getBestCompatibleMint } from './submission';
import type { LoomWorker } from './types';

export interface WalletPromptState {
  selectedMint: string;
  paymentAmount: number;
  autoTokenPromptOpen: boolean;
  autoTokenPromptKey: string;
  autoTokenDismissedKey: string;
}

export function reconcileWalletSelection(args: {
  selectedWorker: LoomWorker | null;
  compatibleMints: string[];
  walletBalancesByMint: Record<string, number>;
  selectedMint: string;
  rerunPaymentToken: string;
  paymentAmount: number;
}) {
  const {
    selectedWorker,
    compatibleMints,
    walletBalancesByMint,
    selectedMint,
    rerunPaymentToken,
    paymentAmount,
  } = args;

  if (!selectedWorker) {
    return {
      selectedMint,
      paymentAmount,
    };
  }

  const bestCompatibleMint = getBestCompatibleMint(compatibleMints, walletBalancesByMint);
  const nextSelectedMint =
    bestCompatibleMint && selectedMint !== bestCompatibleMint ? bestCompatibleMint : selectedMint;

  const suggested = suggestedPaymentAmount(selectedWorker);
  let nextPaymentAmount = paymentAmount;
  
  if (!rerunPaymentToken) {
    if (paymentAmount <= 0) {
      nextPaymentAmount = suggested;
    } else {
      const defaultAmount = suggestedPaymentAmount(null);
      if (paymentAmount === defaultAmount && suggested !== defaultAmount) {
        nextPaymentAmount = suggested;
      }
    }
  }

  return {
    selectedMint: nextSelectedMint,
    paymentAmount: nextPaymentAmount,
  };
}

export function reconcileAutoTokenPrompt(args: {
  autoTokenCandidateKey: string;
  autoTokenPromptKey: string;
  autoTokenDismissedKey: string;
  generatingPaymentToken: boolean;
}) {
  const {
    autoTokenCandidateKey,
    autoTokenPromptKey,
    autoTokenDismissedKey,
    generatingPaymentToken,
  } = args;

  if (!autoTokenCandidateKey) {
    return {
      autoTokenPromptOpen: false,
      autoTokenPromptKey: '',
    };
  }

  if (autoTokenCandidateKey === autoTokenDismissedKey || generatingPaymentToken) {
    return {
      autoTokenPromptOpen: false,
      autoTokenPromptKey,
    };
  }

  if (autoTokenCandidateKey !== autoTokenPromptKey) {
    return {
      autoTokenPromptOpen: true,
      autoTokenPromptKey: autoTokenCandidateKey,
    };
  }

  return {
    autoTokenPromptOpen: true,
    autoTokenPromptKey,
  };
}
