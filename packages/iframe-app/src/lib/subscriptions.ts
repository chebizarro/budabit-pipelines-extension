import type { WidgetBridge } from '@flotilla/ext-shared';
import type { NostrEvent } from './types';

/**
 * Subscription-driven live updates via the host bridge.
 *
 * The host opens a persistent Nostr subscription and streams events
 * back to the widget via bridge events. This avoids polling and gives
 * true real-time updates.
 *
 * If the host doesn't support nostr:subscribe, falls back gracefully.
 */

type EventCallback = (event: NostrEvent) => void;

interface ActiveSubscription {
  id: string;
  onEvent: EventCallback;
}

const activeSubs = new Map<string, ActiveSubscription>();
let listenerAttached = false;
let listenerCleanup: (() => void) | null = null;

/**
 * Attach the global bridge event listener for subscription events.
 * Must be called once when the bridge is ready.
 */
export function attachSubscriptionListener(bridge: WidgetBridge): () => void {
  if (listenerAttached && listenerCleanup) {
    return listenerCleanup;
  }

  const off = bridge.onEvent('nostr:subscription:event', (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const { subscriptionId, event } = payload as { subscriptionId?: string; event?: NostrEvent };
    if (!subscriptionId || !event) return;

    const sub = activeSubs.get(subscriptionId);
    if (sub) {
      sub.onEvent(event);
    }
  });

  listenerAttached = true;
  listenerCleanup = () => {
    off();
    listenerAttached = false;
    listenerCleanup = null;
  };

  return listenerCleanup;
}

/**
 * Open a persistent Nostr subscription via the host bridge.
 * Returns the subscription ID on success, or null if the host
 * doesn't support subscriptions (caller should fall back to polling).
 */
export async function subscribe(
  bridge: WidgetBridge,
  relays: string[],
  filter: Record<string, unknown>,
  onEvent: EventCallback
): Promise<string | null> {
  try {
    const response: any = await bridge.request('nostr:subscribe', { relays, filter });

    if (response?.error) {
      console.log('[pipelines] nostr:subscribe not supported:', response.error);
      return null;
    }

    const subscriptionId = response?.subscriptionId;
    if (!subscriptionId || typeof subscriptionId !== 'string') {
      console.log('[pipelines] nostr:subscribe returned no subscriptionId');
      return null;
    }

    activeSubs.set(subscriptionId, { id: subscriptionId, onEvent });
    console.log('[pipelines] subscribed:', subscriptionId, filter);
    return subscriptionId;
  } catch (err) {
    // Host doesn't support nostr:subscribe — not an error, just unsupported
    console.log('[pipelines] nostr:subscribe failed (host may not support it):', err);
    return null;
  }
}

/**
 * Close a subscription.
 */
export async function unsubscribe(bridge: WidgetBridge, subscriptionId: string): Promise<void> {
  activeSubs.delete(subscriptionId);
  try {
    await bridge.request('nostr:unsubscribe', { subscriptionId });
  } catch {
    // Best effort — host may not support it
  }
}

/**
 * Close all active subscriptions and detach the listener.
 */
export function unsubscribeAll(bridge: WidgetBridge): void {
  const ids = Array.from(activeSubs.keys());
  activeSubs.clear();

  for (const id of ids) {
    bridge.request('nostr:unsubscribe', { subscriptionId: id }).catch(() => {});
  }

  if (listenerCleanup) {
    listenerCleanup();
  }
}

/**
 * Check whether the host supports subscriptions by probing once.
 * Caches the result.
 */
let subscriptionSupported: boolean | null = null;

export async function isSubscriptionSupported(bridge: WidgetBridge): Promise<boolean> {
  if (subscriptionSupported !== null) return subscriptionSupported;

  try {
    const response: any = await bridge.request('nostr:subscribe', {
      relays: ['wss://relay.damus.io'],
      filter: { kinds: [10100], limit: 0 },
    });

    if (response?.subscriptionId) {
      // Close the probe subscription immediately
      await unsubscribe(bridge, response.subscriptionId);
      subscriptionSupported = true;
    } else {
      subscriptionSupported = false;
    }
  } catch {
    subscriptionSupported = false;
  }

  console.log('[pipelines] subscription support:', subscriptionSupported);
  return subscriptionSupported;
}
