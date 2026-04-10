<script lang="ts">
  import { page } from '$app/stores';
  import { sidebarCollapsed } from '$lib/stores';

  const links = [
    { href: '/', label: 'Control Room' },
    { href: '/paper-desk', label: 'Paper Desk' },
    { href: '/positions', label: 'Positions' },
    { href: '/orders', label: 'Orders' },
    { href: '/strategies', label: 'Strategies' },
    { href: '/research', label: 'Research' },
    { href: '/copy-sleeve', label: 'Copy Sleeve' },
    { href: '/macro-preservation', label: 'Macro' },
    { href: '/capital-allocation', label: 'Capital' },
    { href: '/quarter-outlook', label: 'Quarter' },
    { href: '/reviews', label: 'Reviews' },
    { href: '/learning', label: 'Learning' },
    { href: '/settings', label: 'Settings' }
  ];
</script>

<aside class="sidebar" class:sidebar--collapsed={$sidebarCollapsed}>
  {#if !$sidebarCollapsed}
    <div class="sidebar-title">HERMES</div>
    <nav>
      {#each links as link}
        <a class:active={$page.url.pathname === link.href} href={link.href}>
          {link.label}
        </a>
      {/each}
    </nav>
  {/if}
</aside>

<style>
  .sidebar {
    padding: 16px 12px;
    background: rgba(6, 10, 16, 0.97);
    overflow-y: auto;
    overflow-x: hidden;
    scrollbar-width: thin;
    scrollbar-color: rgba(125, 163, 214, 0.15) transparent;
  }

  .sidebar--collapsed {
    padding: 0;
    overflow: hidden;
  }

  .sidebar-title {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.95rem;
    font-weight: 700;
    letter-spacing: 0.15em;
    color: #58d0ff;
    margin-bottom: 12px;
    padding-left: 4px;
  }

  nav {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  nav a {
    display: block;
    padding: 6px 10px;
    border-radius: 4px;
    text-decoration: none;
    color: #e5eefb;
    font-size: 0.82rem;
    font-weight: 500;
    transition: background 0.1s;
  }

  nav a:hover {
    background: rgba(88, 208, 255, 0.06);
  }

  nav a.active {
    background: rgba(88, 208, 255, 0.1);
    border-left: 2px solid #58d0ff;
    color: #58d0ff;
  }
</style>
