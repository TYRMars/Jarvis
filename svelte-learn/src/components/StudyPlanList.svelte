<script lang="ts">
  import { fade } from 'svelte/transition';
  import StudyPlanCard from './StudyPlanCard.svelte';
  import { plansStore } from '../stores/plans';

  $: plans = $plansStore;
  $: totalTasks = plans.reduce((sum, p) => sum + p.tasks.length, 0);
  $: completedTasks = plans.reduce(
    (sum, p) => sum + p.tasks.filter((t) => t.completed).length,
    0
  );
  $: overallProgress = totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100);

  function handleDelete(planId: string) {
    plansStore.deletePlan(planId);
  }

  function handleToggleTask(event: CustomEvent<{ planId: string; taskId: string }>) {
    const { planId, taskId } = event.detail;
    plansStore.toggleTask(planId, taskId);
  }
</script>

<section class="plan-list-section">
  <header class="list-header">
    <h2>📚 学习计划</h2>
    <div class="overall-progress">
      <span class="progress-label">总进度</span>
      <div class="overall-bar">
        <div class="overall-fill" style="width: {overallProgress}%"></div>
        <span class="overall-text">{completedTasks}/{totalTasks} ({overallProgress}%)</span>
      </div>
    </div>
  </header>

  {#if plans.length > 0}
    <div class="cards-container">
      {#each plans as plan (plan.id)}
        <StudyPlanCard
          {plan}
          on:delete={() => handleDelete(plan.id)}
          on:toggleTask={handleToggleTask}
        />
      {/each}
    </div>
  {:else}
    <p class="empty-state" in:fade={{ duration: 300 }}>
      暂无学习计划，去添加一个吧！
    </p>
  {/if}
</section>

<style>
  .plan-list-section {
    max-width: 640px;
    margin: 0 auto;
    padding: 1rem;
  }

  .list-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-bottom: 1.25rem;
  }

  .list-header h2 {
    margin: 0;
    font-size: 1.5rem;
    color: #0f172a;
  }

  .overall-progress {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .progress-label {
    font-size: 0.85rem;
    color: #64748b;
  }

  .overall-bar {
    position: relative;
    width: 160px;
    height: 1.25rem;
    background: #e2e8f0;
    border-radius: 999px;
    overflow: hidden;
  }

  .overall-fill {
    height: 100%;
    background: #6366f1;
    border-radius: 999px;
    transition: width 0.3s ease;
  }

  .overall-text {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    color: #1e293b;
    font-weight: 600;
  }

  .cards-container {
    display: flex;
    flex-direction: column;
  }

  .empty-state {
    text-align: center;
    color: #94a3b8;
    padding: 2rem;
    font-size: 1rem;
  }
</style>
