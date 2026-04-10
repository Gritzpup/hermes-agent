import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const initialCollapsed = browser ? localStorage.getItem('sidebar-collapsed') === 'true' : false;
export const sidebarCollapsed = writable(initialCollapsed);

if (browser) {
  sidebarCollapsed.subscribe(value => {
    localStorage.setItem('sidebar-collapsed', String(value));
  });
}
