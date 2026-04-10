<script lang="ts">
  import type { PageData } from './$types';
  import { currency, signed } from '$lib/format';
  import Panel from '$lib/components/Panel.svelte';

  export let data: PageData;
</script>

<Panel title="Positions" subtitle="Cross-broker inventory with live thesis context.">
  <div class="table-wrap">
    <table class="table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Broker</th>
          <th>Strategy</th>
          <th>Asset</th>
          <th>Quantity</th>
          <th>Avg Entry</th>
          <th>Mark</th>
          <th>PnL</th>
          <th>Opened</th>
          <th>Thesis</th>
        </tr>
      </thead>
      <tbody>
        {#each data.positions as position}
          <tr>
            <td>{position.symbol}</td>
            <td>{position.broker}</td>
            <td>{position.strategy}</td>
            <td>{position.assetClass}</td>
            <td>{position.quantity}</td>
            <td>{currency(position.avgEntry)}</td>
            <td>{currency(position.markPrice)}</td>
            <td class:status-positive={position.unrealizedPnl >= 0} class:status-negative={position.unrealizedPnl < 0}>{signed(position.unrealizedPnl)}</td>
            <td>{new Date(position.openedAt).toLocaleString()}</td>
            <td>{position.thesis}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</Panel>
