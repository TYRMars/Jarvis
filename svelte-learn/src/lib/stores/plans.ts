import { writable } from 'svelte/store';

export interface Task {
  id: number;
  title: string;
  completed: boolean;
}

export interface StudyPlan {
  id: number;
  title: string;
  tasks: Task[];
}

function createPlansStore() {
  const { subscribe, update, set } = writable<StudyPlan[]>([
    {
      id: 1,
      title: 'Svelte 基础',
      tasks: [
        { id: 1, title: '学习响应式声明', completed: true },
        { id: 2, title: '掌握 Props 传递', completed: true },
        { id: 3, title: '理解事件绑定', completed: false },
      ],
    },
    {
      id: 2,
      title: 'Svelte 进阶',
      tasks: [
        { id: 4, title: '条件渲染 {#if}', completed: false },
        { id: 5, title: '列表渲染 {#each}', completed: false },
        { id: 6, title: '过渡动画 transition', completed: false },
      ],
    },
    {
      id: 3,
      title: '项目实战',
      tasks: [
        { id: 7, title: '搭建项目结构', completed: false },
        { id: 8, title: '组件通信', completed: false },
      ],
    },
  ]);

  return {
    subscribe,
    set,
    toggleTask: (planId: number, taskId: number) =>
      update((plans) =>
        plans.map((plan) =>
          plan.id !== planId
            ? plan
            : {
                ...plan,
                tasks: plan.tasks.map((task) =>
                  task.id !== taskId ? task : { ...task, completed: !task.completed }
                ),
              }
        )
      ),
    removePlan: (planId: number) =>
      update((plans) => plans.filter((p) => p.id !== planId)),
  };
}

export const plans = createPlansStore();
