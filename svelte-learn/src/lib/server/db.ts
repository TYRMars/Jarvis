import fs from 'node:fs';
import path from 'node:path';
import type { StudyPlan, Task } from '../../types';

const DB_PATH = path.resolve('data/plans.json');

function readDb(): StudyPlan[] {
	try {
		const raw = fs.readFileSync(DB_PATH, 'utf-8');
		return JSON.parse(raw) as StudyPlan[];
	} catch {
		return [];
	}
}

function writeDb(plans: StudyPlan[]): void {
	fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
	fs.writeFileSync(DB_PATH, JSON.stringify(plans, null, 2), 'utf-8');
}

export function getPlans(): StudyPlan[] {
	return readDb();
}

export function getPlanById(id: string): StudyPlan | undefined {
	return readDb().find((p) => p.id === id);
}

export function createPlan(title: string): StudyPlan {
	const plans = readDb();
	const plan: StudyPlan = {
		id: crypto.randomUUID(),
		title,
		tasks: [
			{ id: crypto.randomUUID(), title: '任务 1', completed: false },
			{ id: crypto.randomUUID(), title: '任务 2', completed: false }
		]
	};
	plans.push(plan);
	writeDb(plans);
	return plan;
}

export function deletePlan(id: string): boolean {
	const plans = readDb();
	const next = plans.filter((p) => p.id !== id);
	if (next.length === plans.length) return false;
	writeDb(next);
	return true;
}

export function toggleTask(planId: string, taskId: string): boolean {
	const plans = readDb();
	const plan = plans.find((p) => p.id === planId);
	if (!plan) return false;
	const task = plan.tasks.find((t) => t.id === taskId);
	if (!task) return false;
	task.completed = !task.completed;
	writeDb(plans);
	return true;
}
