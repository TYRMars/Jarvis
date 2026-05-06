<script>
  import { createEventDispatcher } from 'svelte'
  import TaskItem from './TaskItem.svelte'

  // 表单数据状态
  let planName = ''
  let goal = ''
  let estimatedDate = ''
  let tasks = [
    { name: '', hours: 1 }
  ]

  // bind:this 引用表单元素
  let formRef = null
  let firstInvalidInput = null

  const dispatch = createEventDispatcher()

  function addTask() {
    tasks = [...tasks, { name: '', hours: 1 }]
  }

  function removeTask(event) {
    const index = event.detail
    if (tasks.length > 1) {
      tasks = tasks.filter((_, i) => i !== index)
    } else {
      // 至少保留一项，清空内容
      tasks = [{ name: '', hours: 1 }]
    }
  }

  function validate() {
    if (!planName.trim()) return '请输入计划名称'
    if (!goal.trim()) return '请输入学习目标'
    if (!estimatedDate) return '请选择预计完成时间'
    for (let i = 0; i < tasks.length; i++) {
      if (!tasks[i].name.trim()) return `第 ${i + 1} 个任务名称不能为空`
      if (!tasks[i].hours || tasks[i].hours <= 0) return `第 ${i + 1} 个任务预计小时必须大于 0`
    }
    return ''
  }

  function handleSubmit(event) {
    event.preventDefault()
    const error = validate()
    if (error) {
      alert(error)
      return
    }

    const payload = {
      planName: planName.trim(),
      goal: goal.trim(),
      estimatedDate,
      tasks: tasks.map(t => ({ name: t.name.trim(), hours: Number(t.hours) }))
    }

    // 通过 createEventDispatcher 向上提交
    dispatch('submit', payload)

    // 提交后可选重置
    // resetForm()
  }

  function resetForm() {
    planName = ''
    goal = ''
    estimatedDate = ''
    tasks = [{ name: '', hours: 1 }]
    if (formRef) formRef.reset()
  }
</script>

<form bind:this={formRef} on:submit={handleSubmit} class="study-plan-form">
  <div class="field">
    <label for="planName">计划名称</label>
    <input id="planName" type="text" bind:value={planName} placeholder="例如：Svelte 入门计划" required />
  </div>

  <div class="field">
    <label for="goal">学习目标</label>
    <textarea id="goal" bind:value={goal} rows="3" placeholder="描述你的学习目标..." required></textarea>
  </div>

  <div class="field">
    <label for="estimatedDate">预计完成时间</label>
    <input id="estimatedDate" type="date" bind:value={estimatedDate} required />
  </div>

  <div class="field">
    <label>学习任务列表</label>
    {#each tasks as task, index (index)}
      <TaskItem {index} {task} on:remove={removeTask} />
    {/each}
    <button type="button" class="btn-add" on:click={addTask}>+ 添加任务</button>
  </div>

  <div class="actions">
    <button type="submit" class="btn-submit">提交计划</button>
    <button type="button" class="btn-reset" on:click={resetForm}>重置</button>
  </div>
</form>

<style>
  .study-plan-form {
    max-width: 600px;
    margin: 0 auto;
    background: white;
    padding: 1.5rem;
    border-radius: 0.75rem;
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
  }
  .field {
    margin-bottom: 1rem;
  }
  label {
    display: block;
    margin-bottom: 0.375rem;
    font-weight: 600;
    color: #374151;
  }
  input, textarea {
    width: 100%;
    padding: 0.5rem;
    border: 1px solid #d1d5db;
    border-radius: 0.375rem;
    box-sizing: border-box;
    font-family: inherit;
  }
  input:focus, textarea:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59,130,246,0.15);
  }
  .btn-add {
    background: #e5e7eb;
    color: #374151;
    border: none;
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    cursor: pointer;
    font-size: 0.875rem;
  }
  .btn-add:hover {
    background: #d1d5db;
  }
  .actions {
    display: flex;
    gap: 0.75rem;
    margin-top: 1.25rem;
  }
  .btn-submit {
    flex: 1;
    background: #3b82f6;
    color: white;
    border: none;
    padding: 0.625rem;
    border-radius: 0.375rem;
    cursor: pointer;
    font-size: 1rem;
  }
  .btn-submit:hover {
    background: #2563eb;
  }
  .btn-reset {
    flex: 0 0 5rem;
    background: #9ca3af;
    color: white;
    border: none;
    padding: 0.625rem;
    border-radius: 0.375rem;
    cursor: pointer;
  }
  .btn-reset:hover {
    background: #6b7280;
  }
</style>
