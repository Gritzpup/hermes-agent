<script lang="ts">
  import '$lib/styles/app.css';
  import { onMount } from 'svelte';
  import { startGlobalSSE } from '$lib/sse-store';
  onMount(() => startGlobalSSE());
</script>

<main class="main">
  <slot />
</main>
