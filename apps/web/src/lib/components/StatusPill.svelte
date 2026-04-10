<script lang="ts">
  import type { ServiceHealthStatus } from '@hermes/contracts';

  export let label: string;
  export let status: ServiceHealthStatus;
</script>

<div class={`status-pill status-${status}`}>
  <span>{label}</span>
</div>
