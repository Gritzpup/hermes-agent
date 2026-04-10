<script lang="ts">
  import Panel from '$lib/components/Panel.svelte';
  import QuarterOutlookSection from '$lib/components/QuarterOutlookSection.svelte';
</script>

<Panel
  title="Quarter Outlook"
  subtitle="Simulation-backed last-quarter performance and next-quarter scenario bands. These are projections, not profit guarantees."
  aside="quarterly KPI"
>
  <QuarterOutlookSection mode="detail" />
</Panel>
