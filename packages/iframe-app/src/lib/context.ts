import type { RepoContext, RepoContextNormalized } from './types';

export function transformHostContext(hostCtx: any): RepoContext {
  const repo = hostCtx?.repo || hostCtx;

  const result: RepoContext = {
    contextId: hostCtx?.contextId,
    userPubkey: hostCtx?.userPubkey,
    relays: hostCtx?.relays || repo?.relays || repo?.repoRelays || [],
    repo: repo
      ? {
          repoPubkey: repo?.pubkey || repo?.repoPubkey || '',
          repoName: repo?.name || repo?.repoName || '',
          repoNaddr: repo?.naddr || repo?.repoNaddr,
          repoRelays: repo?.relays || repo?.repoRelays || [],
          maintainers: repo?.maintainers || [],
        }
      : undefined,
  };

  console.log('[pipelines] transformHostContext:', {
    inputKeys: Object.keys(hostCtx || {}),
    repoPubkey: result.repo?.repoPubkey?.slice(0, 12),
    repoName: result.repo?.repoName,
    repoNaddr: result.repo?.repoNaddr?.slice(0, 30),
    relayCount: result.repo?.repoRelays?.length,
  });

  return result;
}

export function normalizeRepo(ctx: RepoContext | null): RepoContextNormalized | null {
  const repo = ctx?.repo;
  if (!repo?.repoPubkey || !repo?.repoName) return null;

  const fallbackRelays = Array.isArray(ctx?.relays)
    ? ctx.relays.filter((value): value is string => typeof value === 'string' && value.length > 0)
    : [];

  const repoRelays = Array.isArray(repo.repoRelays)
    ? repo.repoRelays.filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      )
    : fallbackRelays;

  return {
    contextId: ctx?.contextId,
    userPubkey: ctx?.userPubkey,
    repoPubkey: repo.repoPubkey,
    repoName: repo.repoName,
    repoNaddr: repo.repoNaddr,
    repoRelays,
    maintainers: Array.isArray(repo.maintainers) ? repo.maintainers : undefined,
  };
}

export function getHostOrigin(): string {
  if (document.referrer) {
    try {
      return new URL(document.referrer).origin;
    } catch {
      // pass
    }
  }

  return '*';
}

export function friendlyErrorMessage(message: string): string {
  const lower = message.toLowerCase();

  if (lower.includes('timed out')) {
    return 'Loading took too long. Try refreshing the Pipelines tab.';
  }

  if (lower.includes('network') || lower.includes('fetch')) {
    return 'Network error while loading pipeline data.';
  }

  if (lower.includes('permission') || lower.includes('denied')) {
    return 'The widget does not have permission for that action.';
  }

  return message.length > 140 ? `${message.slice(0, 140)}…` : message;
}
