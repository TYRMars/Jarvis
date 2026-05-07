export interface Task {
  id: string;
  title: string;
  completed: boolean;
}

export interface StudyPlan {
  id: string;
  title: string;
  tasks: Task[];
}
