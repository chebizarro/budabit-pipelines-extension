import {EventStore} from 'applesauce-core';
import {RelayPool} from 'applesauce-relay';
import {createEventLoaderForStore} from 'applesauce-loaders/loaders';

/**
 * Shared nostr primitives for the widget.
 *
 * Phase 1: in-memory EventStore. Phase 1b will swap in a Turso-WASM
 * persistent database so cold loads are instant across sessions.
 */

export const eventStore = new EventStore();
export const pool = new RelayPool();

/** Well-known relays that index profile/metadata events for everyone. */
const PROFILE_LOOKUP_RELAYS = ['wss://purplepag.es', 'wss://index.hzrd149.com'];

/**
 * Populate `eventStore.eventLoader` so `eventStore.model(ProfileModel, pubkey)`
 * (and any other id/address lookups) will lazily fetch missing events from
 * relays and stream them back into the store.
 */
eventStore.eventLoader = createEventLoaderForStore(eventStore, pool, {
  lookupRelays: PROFILE_LOOKUP_RELAYS,
  bufferTime: 250,
});
