<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import { quintOut } from 'svelte/easing';
  import { createEventDispatcher } from 'svelte';
  import type { StudyPlan } from '../types';

  export let plan: StudyPlan;

  const dispatch = createEventDispatcher<{
    delete: string;
    toggleTask: { planId: string; taskId: string };
  }>();

  $: completedCount = plan.tasks.filter((t) => t.completed).length;
  $: totalCount = plan.tasks.length;
  $: progressPercent = totalCount === 0 ? 0 : Math.round((completedCount / totalCount) * 100);
  $: allCompleted = totalCount > 0 && completedCount === totalCount;

  function handleDelete() {
    dispatch('delete', plan.id);
  }

  function handleToggleTask(taskId: string) {
    dispatch('toggleTask', { planId: plan.id, taskId });
  }
</script>

<article
  class="plan-card"
  class:all-completed={allCompleted}
  in:fly={{ y: 20, duration: 400, easing: quintOut }}
  out:fade={{ duration: 250 }}
>
  <header class="card-header">
    <h3>{plan.title}</h3>
    <button class="delete-btn" on:click={handleDelete} aria-label="删除计划">
      ×
    </button>
  </header>

  <div class="progress-bar-container">
    <div class="progress-bar" style="width: {progressPercent}%" class:full={allCompleted}></div>
    <span class="progress-text">{completedCount}/{totalCount} ({progressPercent}%)</span>
  </div>

  {#if plan.tasks.length > 0}
    <ul class="task-list">
      {#each plan.tasks as task (task.id)}
        <li
          class="task-item"
          class:completed={task.completed}
          in:fly={{ x: -10, duration: 300, easing: quintOut }}
        >
          <label class="task-label">
            <input
              type="checkbox"
              checked={task.completed}
              on:change={() => handleToggleTask(task.id)}
            />
            <span class="task-title">{task.title}</span>
          </label>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty-hint" in:fade={{ duration: 200 }}>暂无任务</p>
  {/if}

  {#if allCompleted}
    <div class="completion-badge" in:fly={{ y: -10, duration: 300 }} out:fade={{ duration: 150 }}>
      🎉 全部完成
    </div>
  {/if}
</article>

<style>
  .plan-card {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    padding: 1rem;
    margin-bottom: 1rem;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);
    transition: border-color 0.2s, box-shadow 0.2s;
    position: relative;
  }

  .plan-card.all-completed {
    border-color: #86efac;
    box-shadow: 0 2px 8px rgba(34, 197, 94, 0.1);
  }

  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }

  .card-header h3 {
    margin: 0;
    font-size: 1.1rem;
    color: #1e293b;
  }

  .delete-btn {
    background: transparent;
    border: none;
    color: #94a3b8;
    font-size: 1.25rem;
    cursor: pointer;
    line-height: 1;
    padding: 0.25rem;
    border-radius: 6px;
    transition: background 0.15s, color 0.15s;
  }

  .delete-btn:hover {
    background: #fee2e2;
    color: #ef4444;
  }

  .progress-bar-container {
    position: relative;
    height: 1.25rem;
    background: #f1f5f9;
    border-radius: 999px;
    overflow: hidden;
    margin-bottom: 0.75rem;
  }

  .progress-bar {
    height: 100%;
    background: #3b82f6;
    border-radius: 999px;
    transition: width 0.3s ease;
  }

  .progress-bar.full {
    background: #22c55e;
  }

  .progress-text {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75rem;
    color: #334155;
    font-weight: 500;
  }

  .task-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .task-item {
    padding: 0.4rem 0;
    border-bottom: 1px solid #f1f5f9;
  }

  .task-item:last-child {
    border-bottom: none;
  }

  .task-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: 0.95rem;
    color: #334155;
  }

  .task-item.completed .task-title {
    text-decoration: line-through;
    color: #94a3b8;
  }

  input[type='checkbox'] {
    width: 1rem;
    height: 1rem;
    accent-color: #3b82f6;
    cursor: pointer;
  }

  .empty-hint {
    margin: 0.5rem 0;
    color: #94a3b8;
    font-size: 0.9rem;
    text-align: center;
  }

  .completion-badge {
    margin-top: 0.75rem;
    padding: 0.35rem 0.75rem;
    background: #dcfce7;
    color: #15803d;
    border-radius: 999px;
    font-size: 0.85rem;
    font-weight: 600;
    text-align: center;
    display: inline-block;
  }
</style>
