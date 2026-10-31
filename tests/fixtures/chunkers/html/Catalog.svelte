<script>
  export let items = [];
  let filter = '';

  $: visible = items.filter(i => i.name.includes(filter));
</script>

<div class="catalog">
  <input bind:value={filter} placeholder="Filter items">

  {#if visible.length === 0}
    <p class="empty">Nothing matches.</p>
  {:else}
    <ul>
      {#each visible as item (item.id)}
        <li class:selected={item.selected}>
          <span>{item.name}</span>
          <button on:click={() => dispatch('pick', item)}>Pick</button>
        </li>
      {/each}
    </ul>
  {/if}

  {#await loadMore()}
    <p>Loading...</p>
  {:then more}
    <p>{more.length} more</p>
  {/await}
</div>

<style>
  .catalog { display: grid; gap: 0.5rem; }
  .selected { font-weight: bold; }
</style>
