import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPlans, createPlan, deletePlan } from '$lib/server/db';

export const GET: RequestHandler = async () => {
	const plans = getPlans();
	return json({ data: plans });
};

export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json().catch(() => ({}));
	const title = typeof body.title === 'string' ? body.title.trim() : '';

	if (!title) {
		throw error(400, '标题不能为空');
	}

	const plan = createPlan(title);
	return json({ data: plan }, { status: 201 });
};

export const DELETE: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('id');

	if (!id) {
		throw error(400, '缺少 id 参数');
	}

	const removed = deletePlan(id);
	if (!removed) {
		throw error(404, '计划不存在');
	}

	return json({ success: true });
};
