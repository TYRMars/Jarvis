<script lang="ts">
  import { fly } from 'svelte/transition';
  import StudyPlanList from './components/StudyPlanList.svelte';
  import { plansStore } from './stores/plans';

  let newPlanTitle = '';
  let showForm = false;

  function handleAddPlan() {
    const title = newPlanTitle.trim();
    if (!title) return;

    const plan = {
      id: crypto.randomUUID(),
      title,
      tasks: [
        { id: crypto.randomUUID(), title: '任务 1', completed: false },
        { id: crypto.randomUUID(), title: '任务 2', completed: false },
      ],
    };

    plansStore.addPlan(plan);
    newPlanTitle = '';
    showForm = false;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      handleAddPlan();
    }
  }
</script>

<main class="app">
  <h1 class="app-title">Svelte 学习计划跟踪器</h1>

  <div class="actions">
    <button class="toggle-form-btn" on:click={() => (showForm = !showForm)}>
      {showForm ? '取消' : '➕ 新建计划'}
    </button>
  </div>

  {#if showForm}
    <div class="add-form" in:fly={{ y: -10, duration: 300 }} out:fly={{ y: -10, duration: 200 }}>
      <input
        type="text"
        placeholder="输入计划名称..."
        bind:value={newPlanTitle}
        on:keydown={handleKeydown}
      />
      <button class="confirm-btn" on:click={handleAddPlan}>添加</button>
    </div>
  {/if}

  <StudyPlanList />
</main>

<style>
  :global(body) {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell,
      'Open Sans', 'Helvetica Neue', sans-serif;
    background: #f8fafc;
    color: #1e293b;
  }

  :global(*) {
    box-sizing: border-box;
  }

  .app {
    padding: 2rem 1rem;
    min-height: 100vh;
  }

  .app-title {
    text-align: center;
    margin: 0 0 1.5rem;
    font-size: 1.75rem;
    color: #0f172a;
  }

  .actions {
    display: flex;
    justify-content: center;
    margin-bottom: 1rem;
  }

  .toggle-form-btn {
    background: #3b82f6;
    color: #fff;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.95rem;
    transition: background 0.15s;
  }

  .toggle-form-btn:hover {
    background: #2563eb;
  }

  .add-form {
    display: flex;
    gap: 0.5rem;
    max-width: 640px;
    margin: 0 auto 1.5rem;
  }

  .add-form input {
    flex: 1;
    padding: 0.5rem 0.75rem;
    border: 1px solid #cbd5e1;
    border-radius: 8px;
    font-size: 0.95rem;
    outline: none;
  }

  .add-form input:focus {
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
  }

  .confirm-btn {
    background: #22c55e;
    color: #fff;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 8px;
    cursor: pointer;
    font-size: 0.95rem;
    transition: background 0.15s;
  }

  .confirm-btn:hover {
    background: #16a34a;
  }
</style>
