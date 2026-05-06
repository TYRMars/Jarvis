<script lang="ts">
  import StudyPlanList from './lib/components/StudyPlanList.svelte';
</script>

<main>
  <StudyPlanList />
</main>

<style>
  :global(body) {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen,
      Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
    background: #f7fafc;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  main {
    min-height: 100vh;
    padding: 2rem 1rem;
    box-sizing: border-box;
  }
</style>
