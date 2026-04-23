<script lang="ts">
  interface Props {
    pubkey: string
    size?: 'sm' | 'md'
    showName?: boolean
    class?: string
  }

  const {
    pubkey,
    size = 'sm',
    showName = true,
    class: className = '',
  }: Props = $props()

  const sizeClass = $derived(size === 'md' ? 'h-6 w-6' : 'h-4 w-4')
  const name = $derived(pubkey ? `${pubkey.slice(0, 8)}…` : 'unknown')
  const initial = $derived(name.charAt(0).toUpperCase() || '?')
</script>

<span class={`inline-flex min-w-0 items-center gap-1.5 ${className}`}>
  <span
    class={`${sizeClass} flex shrink-0 items-center justify-center rounded-full bg-muted text-[0.6rem] font-medium uppercase text-muted-foreground`}
  >
    {initial}
  </span>
  {#if showName}
    <span class="truncate font-mono">{name}</span>
  {/if}
</span>
