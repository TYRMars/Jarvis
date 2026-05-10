import { error, json } from "@sveltejs/kit";
import { d as deletePlan, g as getPlans, c as createPlan } from "../../../../chunks/db.js";
const GET = async () => {
  const plans = getPlans();
  return json({ data: plans });
};
const POST = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    throw error(400, "标题不能为空");
  }
  const plan = createPlan(title);
  return json({ data: plan }, { status: 201 });
};
const DELETE = async ({ url }) => {
  const id = url.searchParams.get("id");
  if (!id) {
    throw error(400, "缺少 id 参数");
  }
  const removed = deletePlan(id);
  if (!removed) {
    throw error(404, "计划不存在");
  }
  return json({ success: true });
};
export {
  DELETE,
  GET,
  POST
};
