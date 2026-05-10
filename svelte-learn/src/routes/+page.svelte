<script lang="ts">
	import { fly, fade } from 'svelte/transition';
	import { quintOut } from 'svelte/easing';
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	import type { StudyPlan } from '../types';

	export let data: PageData;
	export let form: ActionData;

	let showForm = false;
	let newPlanTitle = '';
	let deletingId: string | null = null;
	let togglingId: string | null = null;

	$: plans = data.plans;
	$: totalTasks = plans.reduce((sum, p) => sum + p.tasks.length, 0);
	$: completedTasks = plans.reduce(
		(sum, p) => sum + p.tasks.filter((t) => t.completed).length,
		0
	);
	$: overallProgress = totalTasks === 0 ? 0 : Math.round((completedTasks / totalTasks) * 100);

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			const formEl = (event.target as HTMLElement).closest('form') as HTMLFormElement;
			formEl?.requestSubmit();
		}
	}

	function handleTaskCheck(event: Event) {
		event.preventDefault();
		const target = event.target as HTMLElement;
		const formEl = target.closest('form') as HTMLFormElement;
		formEl?.requestSubmit();
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
		<form
			class="add-form"
			method="POST"
			action="?/create"
			use:enhance={() => {
				return async ({ update }) => {
					await update();
					newPlanTitle = '';
					showForm = false;
				};
			}}
			in:fly={{ y: -10, duration: 300 }}
			out:fly={{ y: -10, duration: 200 }}
		>
			<input
				type="text"
				name="title"
				placeholder="输入计划名称..."
				bind:value={newPlanTitle}
				on:keydown={handleKeydown}
				required
			/>
			<button class="confirm-btn" type="submit">添加</button>
		</form>
	{/if}

	{#if form?.message}
		<p class="form-error" transition:fade={{ duration: 200 }}>{form.message}</p>
	{/if}

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
					{@const completedCount = plan.tasks.filter((t) => t.completed).length}
					{@const totalCount = plan.tasks.length}
					{@const progressPercent = totalCount === 0 ? 0 : Math.round((completedCount / totalCount) * 100)}
					{@const allCompleted = totalCount > 0 && completedCount === totalCount}

					<article
						class="plan-card"
						class:all-completed={allCompleted}
						in:fly={{ y: 20, duration: 400, easing: quintOut }}
						out:fade={{ duration: 250 }}
					>
						<header class="card-header">
							<h3>{plan.title}</h3>
							<form
								method="POST"
								action="?/delete"
								use:enhance={() => {
									deletingId = plan.id;
									return async ({ update }) => {
										await update();
										deletingId = null;
									};
								}}
								class="inline-form"
							>
								<input type="hidden" name="id" value={plan.id} />
								<button
									class="delete-btn"
									type="submit"
									disabled={deletingId === plan.id}
									aria-label="删除计划"
								>
									{deletingId === plan.id ? '...' : '×'}
								</button>
							</form>
						</header>

						<div class="progress-bar-container">
							<div
								class="progress-bar"
								style="width: {progressPercent}%"
								class:full={allCompleted}
							></div>
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
										<form
											method="POST"
											action="?/toggleTask"
											use:enhance={() => {
												return async ({ update }) => {
													await update();
												};
											}}
											class="inline-form"
										>
											<input type="hidden" name="planId" value={plan.id} />
											<input type="hidden" name="taskId" value={task.id} />
											<label class="task-label">
												<input
													type="checkbox"
													checked={task.completed}
													on:click={handleTaskCheck}
												/>
												<span class="task-title">{task.title}</span>
											</label>
										</form>
									</li>
								{/each}
							</ul>
						{:else}
							<p class="empty-hint" in:fade={{ duration: 200 }}>暂无任务</p>
						{/if}

						{#if allCompleted}
							<div
								class="completion-badge"
								in:fly={{ y: -10, duration: 300 }}
								out:fade={{ duration: 150 }}
							>
								🎉 全部完成
							</div>
						{/if}
					</article>
				{/each}
			</div>
		{:else}
			<p class="empty-state" in:fade={{ duration: 300 }}>
				暂无学习计划，去添加一个吧！
			</p>
		{/if}
	</section>
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

	.form-error {
		color: #ef4444;
		text-align: center;
		margin: 0 auto 1rem;
		max-width: 640px;
	}

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

	.inline-form {
		display: inline;
		margin: 0;
		padding: 0;
	}
</style>
