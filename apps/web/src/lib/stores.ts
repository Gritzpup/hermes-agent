import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';

export const sidebarCollapsed = writable(false);

if (browser) {
  // Restore from localStorage after client hydration
  const saved = localStorage.getItem('sidebar-collapsed');
  if (saved === 'true') sidebarCollapsed.set(true);

  // Persist future changes — skip writing until after the restore above
  let initialized = false;
  sidebarCollapsed.subscribe(value => {
    if (!initialized) { initialized = true; return; }
    localStorage.setItem('sidebar-collapsed', String(value));
  });
}
