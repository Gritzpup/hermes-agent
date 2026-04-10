<script lang="ts">
  import type { PageData } from './$types';
  import { currency } from '$lib/format';
  import Panel from '$lib/components/Panel.svelte';

  export let data: PageData;
</script>

<Panel title="Orders and Fills" subtitle="Latency, slippage, and broker routing behavior in one place.">
  <div class="table-wrap">
    <table class="table">
      <thead>
        <tr>
          <th>Order</th>
          <th>Broker</th>
          <th>Symbol</th>
          <th>Status</th>
          <th>Qty</th>
          <th>Avg Fill</th>
          <th>Slippage</th>
          <th>Latency</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>
        {#each data.orders as order}
          <tr>
            <td>{order.orderId}</td>
            <td>{order.broker}</td>
            <td>{order.symbol}</td>
            <td><span class="badge">{order.status}</span></td>
            <td>{order.filledQty}</td>
            <td>{order.avgFillPrice ? currency(order.avgFillPrice) : 'Pending'}</td>
            <td>{order.slippageBps} bps</td>
            <td>{order.latencyMs} ms</td>
            <td>{order.message}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</Panel>
