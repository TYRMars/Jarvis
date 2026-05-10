import { t as toggleTask, d as deletePlan, c as createPlan, g as getPlans } from "../../chunks/db.js";
import { fail, error } from "@sveltejs/kit";
const load = async () => {
  const plans = getPlans();
  if (!plans) {
    throw error(500, "无法加载学习计划");
  }
  return { plans };
};
const actions = {
  create: async ({ request }) => {
    const formData = await request.formData();
    const title = formData.get("title")?.toString().trim() ?? "";
    if (!title) {
      return fail(400, { message: "标题不能为空" });
    }
    const plan = createPlan(title);
    return { success: true, plan };
  },
  delete: async ({ request }) => {
    const formData = await request.formData();
    const id = formData.get("id")?.toString() ?? "";
    if (!id) {
      return fail(400, { message: "ID 不能为空" });
    }
    const removed = deletePlan(id);
    if (!removed) {
      return fail(404, { message: "计划不存在" });
    }
    return { success: true };
  },
  toggleTask: async ({ request }) => {
    const formData = await request.formData();
    const planId = formData.get("planId")?.toString() ?? "";
    const taskId = formData.get("taskId")?.toString() ?? "";
    if (!planId || !taskId) {
      return fail(400, { message: "参数不完整" });
    }
    const ok = toggleTask(planId, taskId);
    if (!ok) {
      return fail(404, { message: "计划或任务不存在" });
    }
    return { success: true };
  }
};
export {
  actions,
  load
};
