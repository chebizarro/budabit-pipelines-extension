import { SimplePool, generateSecretKey, getPublicKey, nip19, type Event, type UnsignedEvent } from 'nostr-tools';
import type { RerunDraft } from './types';

interface NostrWindowSigner {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedEvent): Promise<Event>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
  };
}

declare global {
  interface Window {
    nostr?: NostrWindowSigner;
  }
}

function hexFromBytes(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function currentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

async function publishEvent(relays: string[], event: Event): Promise<void> {
  const uniqueRelays = Array.from(new Set(relays.filter(Boolean)));
  const pool = new SimplePool();

  try {
    await Promise.allSettled(pool.publish(uniqueRelays, event));
  } finally {
    pool.close(uniqueRelays);
  }
}

export function getNip07Signer(): NostrWindowSigner | null {
  return window.nostr || null;
}

export async function connectNip07Signer(): Promise<string> {
  const signer = getNip07Signer();
  if (!signer) {
    throw new Error('No NIP-07 signer found in this browser.');
  }

  return signer.getPublicKey();
}

export async function submitRerun(
  signerPubkey: string,
  draft: RerunDraft,
  paymentToken: string,
  secrets: Array<{ key: string; value: string }>
): Promise<string> {
  const signer = getNip07Signer();
  if (!signer) throw new Error('No NIP-07 signer found in this browser.');
  if (!signer.nip44?.encrypt) {
    throw new Error('This NIP-07 signer does not expose NIP-44 encryption.');
  }

  const ephemeralSecretKey = generateSecretKey();
  const ephemeralPubkey = getPublicKey(ephemeralSecretKey);
  const ephemeralSecretKeyHex = hexFromBytes(ephemeralSecretKey);

  const workflowRunEvent = {
    kind: 5401,
    created_at: currentTimestamp(),
    content: '',
    tags: [
      ['a', draft.repoNaddr],
      ['workflow', draft.workflowPath],
      ['triggered-by', signerPubkey],
      ['publisher', ephemeralPubkey],
      ['trigger', 'manual'],
      ['branch', draft.branch],
      ['commit', draft.commit],
      ['t', 'hive-ci'],
    ],
    pubkey: signerPubkey,
  } satisfies UnsignedEvent;

  const runEvent = await signer.signEvent(workflowRunEvent);
  const runId = runEvent.id;

  const envTags: string[][] = [
    ['env', 'HIVE_CI_RUN_ID', runId],
    ['env', 'HIVE_CI_REPOSITORY', draft.repoNostrUrl],
    ['env', 'HIVE_CI_WORKFLOW', draft.workflowPath],
    ['env', 'HIVE_CI_BRANCH', draft.branch],
    ['env', 'HIVE_CI_COMMIT', draft.commit],
    ['env', 'HIVE_CI_RELAYS', draft.publishRelays.join(',')],
    ['env', 'HIVE_CI_BLOSSOM_SERVER', 'https://blossom.primal.net'],
    ...draft.envVars
      .filter(entry => entry.key.trim() && entry.value.trim())
      .map(entry => ['env', entry.key.trim(), entry.value]),
  ];

  const secretTags: string[][] = [
    ['secret', 'HIVE_CI_NSEC', await signer.nip44.encrypt(draft.workerPubkey, ephemeralSecretKeyHex)],
  ];

  for (const secret of secrets.filter(entry => entry.key.trim() && entry.value.trim())) {
    const encrypted = await signer.nip44.encrypt(draft.workerPubkey, secret.value);
    secretTags.push(['secret', secret.key.trim(), encrypted]);
  }

  const loomJobEvent = {
    kind: 5100,
    created_at: currentTimestamp(),
    content: '',
    tags: [
      ['p', draft.workerPubkey],
      ['e', runId],
      ['cmd', draft.command],
      ['args', ...draft.args],
      ['payment', paymentToken],
      ...envTags,
      ...secretTags,
    ],
    pubkey: signerPubkey,
  } satisfies UnsignedEvent;

  const signedLoomJobEvent = await signer.signEvent(loomJobEvent);

  await publishEvent(draft.publishRelays, runEvent);
  await publishEvent(draft.publishRelays, signedLoomJobEvent);

  return runId;
}

export function toRepoNostrUrl(repoNaddr: string | undefined, relays: string[]): string {
  if (!repoNaddr) return '';

  try {
    const parts = repoNaddr.split(':');
    if (parts.length !== 3) return '';

    const [, pubkey, identifier] = parts;
    if (!pubkey || !identifier) return '';
    const npub = nip19.npubEncode(pubkey);
    const relayHints = relays.map(relay => encodeURIComponent(relay)).join('/');
    return relayHints ? `nostr://${npub}/${relayHints}/${identifier}` : `nostr://${npub}/${identifier}`;
  } catch {
    return '';
  }
}
