<script lang="ts">
  import type { LayoutData } from './$types';
  import '$lib/styles/app.css';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import { sidebarCollapsed } from '$lib/stores';
  import StatusPill from '$lib/components/StatusPill.svelte';

  export let data: LayoutData;
</script>

<div class="shell" class:shell--collapsed={$sidebarCollapsed}>
  <Sidebar />

  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="shell-handle" on:click={() => sidebarCollapsed.update(v => !v)}>
    <div class="shell-handle__grips">
      <div class="shell-handle__bar"></div>
      <div class="shell-handle__bar"></div>
      <div class="shell-handle__bar"></div>
    </div>
    <div class="shell-handle__arrow">{$sidebarCollapsed ? '\u25B6' : '\u25C0'}</div>
    <div class="shell-handle__grips">
      <div class="shell-handle__bar"></div>
      <div class="shell-handle__bar"></div>
      <div class="shell-handle__bar"></div>
    </div>
  </div>

  <main class="main">
    <div class="health-strip">
      {#each data.serviceHealth as service}
        <StatusPill label={`${service.name} · ${service.message}`} status={service.status} />
      {/each}
    </div>

    <slot />
  </main>
</div>
