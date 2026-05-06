<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import StudyPlanCard from './StudyPlanCard.svelte';
  import { plans } from '../stores/plans';

  $: allTasks = $plans.reduce(
    (acc, plan) => acc + plan.tasks.length,
    0
  );
  $: allCompleted = $plans.reduce(
    (acc, plan) => acc + plan.tasks.filter((t) => t.completed).length,
    0
  );
  $: overallProgress = allTasks === 0 ? 0 : Math.round((allCompleted / allTasks) * 100);

  function handleToggle(event: CustomEvent<{ planId: number; taskId: number }>) {
    plans.toggleTask(event.detail.planId, event.detail.taskId);
  }

  function handleRemove(event: CustomEvent<{ planId: number }>) {
    plans.removePlan(event.detail.planId);
  }
</script>

<section class="plan-list">
  <header class="list-header">
    <h2>📚 学习计划</h2>
    <div class="overall-progress">
      <span class="overall-label">总进度</span>
      <div class="overall-bar-wrapper">
        <div class="overall-bar" style="width: {overallProgress}%"></div>
        <span class="overall-text">{allCompleted}/{allTasks} ({overallProgress}%)</span>
      </div>
    </div>
  </header>

  {#if $plans.length > 0}
    <div class="cards-wrapper">
      {#each $plans as plan (plan.id)}
        <StudyPlanCard
          {plan}
          on:toggle={handleToggle}
          on:remove={handleRemove}
        />
      {/each}
    </div>
  {:else}
    <div class="empty-state" in:fade>
      <p>暂无学习计划，去添加一个吧！</p>
    </div>
  {/if}
</section>

<style>
  .plan-list {
    max-width: 640px;
    margin: 0 auto;
    padding: 1.5rem;
  }
  .list-header {
    margin-bottom: 1.5rem;
  }
  .list-header h2 {
    margin: 0 0 0.75rem;
    font-size: 1.5rem;
    color: #1a202c;
  }
  .overall-progress {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .overall-label {
    font-size: 0.85rem;
    color: #718096;
    font-weight: 500;
    white-space: nowrap;
  }
  .overall-bar-wrapper {
    position: relative;
    flex: 1;
    background: #edf2f7;
    border-radius: 999px;
    height: 1.5rem;
    overflow: hidden;
  }
  .overall-bar {
    height: 100%;
    background: linear-gradient(90deg, #68d391, #48bb78);
    border-radius: 999px;
    transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .overall-text {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 0.75rem;
    font-weight: 600;
    color: #2d3748;
  }
  .empty-state {
    text-align: center;
    padding: 3rem 1rem;
    color: #a0aec0;
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
  }
  .empty-state p {
    margin: 0;
    font-size: 1rem;
  }
</style>
