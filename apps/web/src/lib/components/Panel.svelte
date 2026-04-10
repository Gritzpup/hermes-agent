<script lang="ts">
  export let title = '';
  export let subtitle = '';
  export let aside = '';
</script>

<section class="panel">
  {#if title}
    <div class="panel-header">
      <div>
        <h3>{title}</h3>
        {#if subtitle}<p>{subtitle}</p>{/if}
      </div>
      {#if aside}<div class="subtle">{aside}</div>{/if}
    </div>
  {/if}

  <slot />
</section>
