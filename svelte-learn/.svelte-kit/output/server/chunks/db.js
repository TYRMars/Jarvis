import fs from "node:fs";
import path from "node:path";
const DB_PATH = path.resolve("data/plans.json");
function readDb() {
  try {
    const raw = fs.readFileSync(DB_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
function writeDb(plans) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(plans, null, 2), "utf-8");
}
function getPlans() {
  return readDb();
}
function createPlan(title) {
  const plans = readDb();
  const plan = {
    id: crypto.randomUUID(),
    title,
    tasks: [
      { id: crypto.randomUUID(), title: "任务 1", completed: false },
      { id: crypto.randomUUID(), title: "任务 2", completed: false }
    ]
  };
  plans.push(plan);
  writeDb(plans);
  return plan;
}
function deletePlan(id) {
  const plans = readDb();
  const next = plans.filter((p) => p.id !== id);
  if (next.length === plans.length) return false;
  writeDb(next);
  return true;
}
function toggleTask(planId, taskId) {
  const plans = readDb();
  const plan = plans.find((p) => p.id === planId);
  if (!plan) return false;
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) return false;
  task.completed = !task.completed;
  writeDb(plans);
  return true;
}
export {
  createPlan as c,
  deletePlan as d,
  getPlans as g,
  toggleTask as t
};
