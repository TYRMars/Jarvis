import { Service } from 'egg';
import { StateGraph } from 'langgraph';
import { ChatOpenAI } from 'langchain/chat_models/openai';
import { ChatPromptTemplate } from 'langchain/prompts';
import { RunnableSequence } from 'langchain/schema/runnable';
import { StringOutputParser } from 'langchain/schema/output_parser';

export default class WorkflowService extends Service {
  // 创建工作流
  async createWorkflow(params: {
    user_id: number;
    name: string;
    description?: string;
    workflow_type: string;
    config: any;
  }) {
    const workflow = await this.ctx.model.AgentWorkflow.create({
      ...params,
      state: {},
    });
    return workflow;
  }

  // 创建工作流节点
  async createNode(params: {
    workflow_id: number;
    node_type: string;
    name: string;
    config: any;
    position: { x: number; y: number };
    edges?: any[];
  }) {
    const node = await this.ctx.model.AgentWorkflowNode.create(params);
    return node;
  }

  // 执行工作流
  async executeWorkflow(workflow_id: number, input: any) {
    const workflow = await this.ctx.model.AgentWorkflow.findByPk(workflow_id);
    if (!workflow) {
      throw new Error('工作流不存在');
    }

    const nodes = await this.ctx.model.AgentWorkflowNode.findAll({
      where: { workflow_id },
    });

    // 构建LangGraph工作流
    const graph = new StateGraph({ channels: { messages: [] } });

    // 添加节点
    for (const node of nodes) {
      const nodeHandler = this.createNodeHandler(node);
      graph.addNode(node.name, nodeHandler);
    }

    // 添加边
    for (const node of nodes) {
      if (node.edges) {
        for (const edge of node.edges) {
          graph.addEdge(node.name, edge.target);
        }
      }
    }

    // 设置入口节点
    const entryNode = nodes.find(n => n.node_type === 'intent_classifier');
    if (entryNode) {
      graph.setEntryPoint(entryNode.name);
    }

    // 编译并执行工作流
    const app = graph.compile();
    const result = await app.invoke({ messages: input });

    return result;
  }

  // 创建节点处理器
  private createNodeHandler(node: any) {
    switch (node.node_type) {
      case 'intent_classifier':
        return this.createIntentClassifier(node.config);
      case 'tool_executor':
        return this.createToolExecutor(node.config);
      case 'rag_retriever':
        return this.createRagRetriever(node.config);
      default:
        throw new Error(`不支持的节点类型: ${node.node_type}`);
    }
  }

  // 创建意图分类器
  private createIntentClassifier(config: any) {
    const model = new ChatOpenAI({
      modelName: config.model_name || 'gpt-3.5-turbo',
      temperature: config.temperature || 0.7,
    });

    const prompt = ChatPromptTemplate.fromTemplate(`
      请分析以下用户输入，识别其意图：
      {input}
      
      请从以下意图中选择最匹配的一个：
      {intents}
      
      输出格式：
      {
        "intent": "意图名称",
        "confidence": 0.95,
        "reason": "选择该意图的原因"
      }
    `);

    return RunnableSequence.from([
      prompt,
      model,
      new StringOutputParser(),
    ]);
  }

  // 创建工具执行器
  private createToolExecutor(config: any) {
    // 实现工具执行逻辑
    return async (state: any) => {
      // 根据配置执行工具
      return state;
    };
  }

  // 创建RAG检索器
  private createRagRetriever(config: any) {
    // 实现RAG检索逻辑
    return async (state: any) => {
      // 根据配置执行检索
      return state;
    };
  }
} 