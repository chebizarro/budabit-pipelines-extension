import { createWidgetBridge, type WidgetBridge } from '@flotilla/ext-shared';
import { getHostOrigin, normalizeRepo, transformHostContext } from './context';
import type { RepoContext } from './types';

interface WidgetLifecycleArgs {
  onBridgeChange: (bridge: WidgetBridge | null) => void;
  onRepoContextChange: (repoContext: RepoContext | null) => void;
  onRefreshRuns: (repo?: ReturnType<typeof normalizeRepo> | null) => void | Promise<void>;
  onRepoChange: () => void;
  onUnmount: () => void;
}

export function setupWidgetLifecycle(args: WidgetLifecycleArgs) {
  const { onBridgeChange, onRepoContextChange, onRefreshRuns, onRepoChange, onUnmount } = args;

  const bridge = createWidgetBridge({
    targetWindow: window.parent,
    targetOrigin: getHostOrigin(),
    timeoutMs: 0,
  });

  onBridgeChange(bridge);

  const handleRepoContext = (input: unknown, options: { resetRunState: boolean }) => {
    const nextRepoCtx = input ? transformHostContext(input) : null;
    onRepoContextChange(nextRepoCtx);
    if (options.resetRunState) {
      onRepoChange();
    }
    void onRefreshRuns(normalizeRepo(nextRepoCtx));
  };

  const offInit = bridge.onEvent('widget:init', (payload: any) => {
    if (payload?.repoContext) {
      handleRepoContext(payload.repoContext, { resetRunState: false });
    }
  });

  const offMounted = bridge.onEvent('widget:mounted', () => {
    void onRefreshRuns();
  });

  const offUnmounting = bridge.onEvent('widget:unmounting', () => {
    onUnmount();
  });

  const offContext = bridge.onEvent('context:update', (ctx: any) => {
    handleRepoContext(ctx, { resetRunState: true });
  });

  const offRepoUpdate = bridge.onEvent('context:repoUpdate', (ctx: any) => {
    handleRepoContext(ctx, { resetRunState: true });
  });

  return () => {
    offInit();
    offMounted();
    offUnmounting();
    offContext();
    offRepoUpdate();
    bridge.destroy();
    onBridgeChange(null);
  };
}
