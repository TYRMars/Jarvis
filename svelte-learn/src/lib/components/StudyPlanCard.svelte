<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { createEventDispatcher } from 'svelte';
  import type { StudyPlan } from '../stores/plans';

  export let plan: StudyPlan;

  const dispatch = createEventDispatcher<{
    toggle: { planId: number; taskId: number };
    remove: { planId: number };
  }>();

  $: total = plan.tasks.length;
  $: completed = plan.tasks.filter((t) => t.completed).length;
  $: progress = total === 0 ? 0 : Math.round((completed / total) * 100);
  $: allDone = total > 0 && completed === total;

  function handleToggle(taskId: number) {
    dispatch('toggle', { planId: plan.id, taskId });
  }

  function handleRemove() {
    dispatch('remove', { planId: plan.id });
  }
</script>

<article
  class="plan-card"
  in:fly={{ y: 20, duration: 400, easing: cubicOut }}
  out:fade={{ duration: 250 }}
>
  <header class="card-header">
    <h3>{plan.title}</h3>
    <button
      class="remove-btn"
      on:click={handleRemove}
      title="删除计划"
      aria-label="删除计划"
    >
      ✕
    </button>
  </header>

  <div class="progress-bar-wrapper">
    <div class="progress-bar" style="width: {progress}%"></div>
    <span class="progress-text">{completed}/{total} ({progress}%)</span>
  </div>

  {#if allDone}
    <p class="done-badge" in:fly={{ y: -10, duration: 300 }}>🎉 全部完成！</p>
  {/if}

  <ul class="task-list">
    {#each plan.tasks as task (task.id)}
      <li
        class="task-item"
        class:completed={task.completed}
        in:fly={{ x: -10, duration: 300, delay: task.id * 50 }}
      >
        <label class="task-label">
          <input
            type="checkbox"
            checked={task.completed}
            on:change={() => handleToggle(task.id)}
          />
          <span class="checkmark"></span>
          <span class="task-title">{task.title}</span>
        </label>
      </li>
    {:else}
      <li class="empty-hint" in:fade>暂无任务</li>
    {/each}
  </ul>
</article>

<style>
  .plan-card {
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
    padding: 1.25rem;
    margin-bottom: 1rem;
    transition: box-shadow 0.2s;
  }
  .plan-card:hover {
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.1);
  }
  .card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
  }
  .card-header h3 {
    margin: 0;
    font-size: 1.15rem;
    color: #2d3748;
  }
  .remove-btn {
    background: transparent;
    border: none;
    color: #a0aec0;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0.25rem;
    border-radius: 4px;
    transition: color 0.2s, background 0.2s;
  }
  .remove-btn:hover {
    color: #e53e3e;
    background: #fff5f5;
  }
  .progress-bar-wrapper {
    position: relative;
    background: #edf2f7;
    border-radius: 999px;
    height: 1.25rem;
    overflow: hidden;
    margin-bottom: 0.75rem;
  }
  .progress-bar {
    height: 100%;
    background: linear-gradient(90deg, #63b3ed, #4299e1);
    border-radius: 999px;
    transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .progress-text {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    font-size: 0.7rem;
    font-weight: 600;
    color: #4a5568;
    white-space: nowrap;
  }
  .done-badge {
    margin: 0 0 0.75rem;
    font-size: 0.9rem;
    color: #38a169;
    font-weight: 600;
    text-align: center;
  }
  .task-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .task-item {
    padding: 0.4rem 0;
    border-bottom: 1px solid #f7fafc;
  }
  .task-item:last-child {
    border-bottom: none;
  }
  .task-label {
    display: flex;
    align-items: center;
    cursor: pointer;
    gap: 0.5rem;
  }
  .task-label input[type='checkbox'] {
    display: none;
  }
  .checkmark {
    width: 1rem;
    height: 1rem;
    border: 2px solid #cbd5e0;
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: border-color 0.2s, background 0.2s;
    flex-shrink: 0;
  }
  .task-label input:checked + .checkmark {
    border-color: #4299e1;
    background: #4299e1;
  }
  .task-label input:checked + .checkmark::after {
    content: '✓';
    color: #fff;
    font-size: 0.7rem;
    font-weight: bold;
  }
  .task-title {
    font-size: 0.95rem;
    color: #2d3748;
    transition: color 0.2s, text-decoration 0.2s;
  }
  .task-item.completed .task-title {
    text-decoration: line-through;
    color: #a0aec0;
  }
  .empty-hint {
    text-align: center;
    color: #a0aec0;
    font-size: 0.85rem;
    padding: 0.5rem 0;
  }
</style>
