<script>
  // 子组件：单个学习任务项
  // 实践事件转发（让父级可以监听子组件的 DOM 事件）
  import { createEventDispatcher } from 'svelte'

  export let index
  export let task

  const dispatch = createEventDispatcher()

  // 绑定 DOM 引用，方便父组件通过 bind:this 调用 focus 等方法
  export let inputRef = null
</script>

<div class="task-item">
  <span class="task-index">#{index + 1}</span>
  <input
    bind:this={inputRef}
    bind:value={task.name}
    placeholder="任务名称"
    class="task-input"
    required
  />
  <input
    type="number"
    bind:value={task.hours}
    placeholder="预计小时"
    min="0.5"
    step="0.5"
    class="task-input task-hours"
    required
  />
  <button
    type="button"
    class="btn-remove"
    on:click={() => dispatch('remove', index)}
  >
    删除
  </button>
</div>

<style>
  .task-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }
  .task-index {
    font-weight: bold;
    color: #4b5563;
    min-width: 1.5rem;
  }
  .task-input {
    flex: 1;
    padding: 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 0.375rem;
  }
  .task-hours {
    flex: 0 0 5rem;
  }
  .btn-remove {
    background: #ef4444;
    color: white;
    border: none;
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    cursor: pointer;
  }
  .btn-remove:hover {
    background: #dc2626;
  }
</style>
