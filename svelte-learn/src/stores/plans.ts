import { writable } from 'svelte/store';
import type { StudyPlan } from '../types';

const initialPlans: StudyPlan[] = [
  {
    id: '1',
    title: 'Svelte 基础学习',
    tasks: [
      { id: 't1', title: '了解 Svelte 响应式原理', completed: true },
      { id: 't2', title: '掌握组件基础语法', completed: true },
      { id: 't3', title: '学习事件绑定与处理', completed: false },
      { id: 't4', title: '实践条件与列表渲染', completed: false },
    ],
  },
  {
    id: '2',
    title: 'Svelte 进阶实战',
    tasks: [
      { id: 't5', title: '使用 Store 进行状态管理', completed: false },
      { id: 't6', title: '掌握过渡与动画', completed: false },
      { id: 't7', title: '组件间通信实践', completed: false },
    ],
  },
];

function createPlansStore() {
  const { subscribe, update } = writable<StudyPlan[]>(initialPlans);

  return {
    subscribe,
    deletePlan: (id: string) =>
      update((plans) => plans.filter((p) => p.id !== id)),
    toggleTask: (planId: string, taskId: string) =>
      update((plans) =>
        plans.map((plan) => {
          if (plan.id !== planId) return plan;
          return {
            ...plan,
            tasks: plan.tasks.map((task) =>
              task.id === taskId ? { ...task, completed: !task.completed } : task
            ),
          };
        })
      ),
    addPlan: (plan: StudyPlan) =>
      update((plans) => [...plans, plan]),
  };
}

export const plansStore = createPlansStore();
