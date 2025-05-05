import { Application } from 'egg';

export default (app: Application) => {
  const { controller, router } = app;

  // MCP API接口（需要在最前面，与其他路由区分）
  router.post('/v1/chat/completions', controller.mcp.chatCompletions);
  router.post('/v1/tools/:name/:toolCallId', controller.mcp.toolExecution);
  router.get('/v1/models', controller.mcp.listModels);
  router.get('/health', controller.mcp.healthCheck);

  // Agent管理
  router.post('/api/agents', controller.agent.create);
  router.put('/api/agents/:id', controller.agent.update);
  router.delete('/api/agents/:id', controller.agent.delete);
  router.get('/api/agents/:id', controller.agent.getById);
  router.get('/api/agents', controller.agent.list);
  
  // 新增：批量处理能力
  router.post('/api/agents/batch', controller.agent.batchCreate);
  router.post('/api/agents/batch-from-templates', controller.agent.batchCreateFromTemplates);
  
  // Agent对话和Prompt相关
  router.post('/api/agents/:id/chat', controller.agent.chat);
  router.post('/api/agents/:id/knowledge/search', controller.agent.searchKnowledge);
  router.post('/api/agents/:id/sessions/clear', controller.agent.clearSession);
  router.get('/api/agents/:id/prompt', controller.agent.getPrompt);
  router.put('/api/agents/:id/custom-prompt', controller.agent.setCustomPrompt);
  router.put('/api/agents/:id/prompt-template', controller.agent.setPromptTemplate);
  
  // 新增：Graph工作流Agent
  router.post('/api/agents/:id/graph-chat', controller.graphAgent.chat);
  
  // 新增：Agent记忆管理
  router.get('/api/agent-memories', controller.agentMemory.getLongTermMemories);
  router.post('/api/agent-memories', controller.agentMemory.setLongTermMemory);
  router.delete('/api/agent-memories', controller.agentMemory.removeLongTermMemory);
  router.post('/api/agent-memories/short-term/clear', controller.agentMemory.clearShortTermMemory);
  router.post('/api/agent-memories/process', controller.agentMemory.processMemoryFromText);
  
  // 新增：Agent评估相关
  router.post('/api/agent-evaluations', controller.agentEvaluation.evaluateResponse);
  router.get('/api/agents/:agent_id/evaluations', controller.agentEvaluation.getEvaluationHistory);
  router.get('/api/agents/:agent_id/evaluation-stats', controller.agentEvaluation.getEvaluationStats);
  router.post('/api/agents/:agent_id/auto-evaluate', controller.agentEvaluation.runAutomaticEvaluation);

  // 提示模板管理
  router.post('/api/prompts', controller.prompt.create);
  router.put('/api/prompts/:id', controller.prompt.update);
  router.delete('/api/prompts/:id', controller.prompt.delete);
  router.get('/api/prompts/:id', controller.prompt.getById);
  router.get('/api/prompts', controller.prompt.list);
  router.post('/api/prompts/:id/render', controller.prompt.render);
  router.get('/api/prompts/categories', controller.prompt.getCategories);
  router.get('/api/prompts/tags', controller.prompt.getTags);
  router.post('/api/prompts/:id/clone', controller.prompt.clone);
  router.post('/api/prompts/create-defaults', controller.prompt.createDefaultTemplates);
  
  // 新增：提示词编辑器
  router.post('/api/prompt-editor/versions', controller.promptEditor.createVersion);
  router.get('/api/prompt-editor/:prompt_id/versions', controller.promptEditor.getVersionHistory);
  router.post('/api/prompt-editor/rollback', controller.promptEditor.rollbackToVersion);
  router.post('/api/prompt-editor/test', controller.promptEditor.testPrompt);
  router.post('/api/prompt-editor/test-with-ai', controller.promptEditor.testPromptWithAI);
  router.post('/api/prompts/:id/generate-examples', controller.prompt.generateExamples);
  router.post('/api/prompts/analyze-variables', controller.prompt.analyzeVariables);

  // 知识库管理
  router.post('/api/knowledge-bases', controller.knowledgeBase.create);
  router.put('/api/knowledge-bases/:id', controller.knowledgeBase.update);
  router.delete('/api/knowledge-bases/:id', controller.knowledgeBase.delete);
  router.get('/api/knowledge-bases/:id', controller.knowledgeBase.getById);
  router.get('/api/knowledge-bases', controller.knowledgeBase.list);
  
  // 新增：批量导入知识库
  router.post('/api/knowledge-bases/batch-import', controller.knowledgeBase.batchImport);
  router.post('/api/knowledge-bases/import-files', controller.knowledgeBase.batchImportFromFiles);
  
  // 知识库操作
  router.post('/api/knowledge-bases/:id/summarize', controller.knowledgeBase.summarize);
  router.post('/api/knowledge-bases/:id/extract-concepts', controller.knowledgeBase.extractConcepts);
  router.post('/api/knowledge-bases/:id/generate-qa', controller.knowledgeBase.generateQAPairs);
  router.post('/api/knowledge-bases/:id/search', controller.knowledgeBase.search);

  // 工具管理
  router.post('/api/tools', controller.tool.create);
  router.put('/api/tools/:id', controller.tool.update);
  router.delete('/api/tools/:id', controller.tool.delete);
  router.get('/api/tools/:id', controller.tool.getById);
  router.get('/api/tools', controller.tool.list);
  
  // 工具操作
  router.post('/api/tools/:id/test', controller.tool.test);
  
  // 对话管理
  router.get('/api/conversations', controller.conversation.list);
  router.get('/api/conversations/:id', controller.conversation.getById);
  router.delete('/api/conversations/:id', controller.conversation.delete);
  router.get('/api/agents/:agentId/conversations', controller.conversation.listByAgent);
  router.get('/api/agents/:agentId/sessions', controller.conversation.listSessions);
  // 新增：创建对话的接口
  router.post('/api/conversations', controller.conversation.create);
  
  // 新增：对话分析功能
  router.post('/api/conversation-analysis', controller.conversationAnalysis.analyzeConversation);
  router.get('/api/agents/:agent_id/conversation-analyses', controller.conversationAnalysis.getAnalysisByAgent);
  router.get('/api/agents/:agent_id/sessions/:session_id/analysis', controller.conversationAnalysis.getAnalysisBySession);
  router.get('/api/agents/:agent_id/analytics', controller.conversationAnalysis.getAgentAnalyticsStats);
  
  // AI 服务接口
  router.post('/api/ai/generate', controller.ai.generate);
  router.post('/api/ai/batch-generate', controller.ai.batchGenerate);
  router.post('/api/ai/generate-from-template', controller.ai.generateFromTemplate);
  router.post('/api/ai/optimize-content', controller.ai.optimizeContent);
  
  // 新增：LLM模型管理
  router.get('/api/ai/models', controller.ai.getAvailableModels);
  router.post('/api/ai/model-test', controller.ai.testModel);
  
  // MCP 服务器管理
  router.post('/api/mcp-servers', controller.mcpServer.create);
  router.put('/api/mcp-servers/:id', controller.mcpServer.update);
  router.delete('/api/mcp-servers/:id', controller.mcpServer.delete);
  router.get('/api/mcp-servers/:id', controller.mcpServer.getById);
  router.get('/api/mcp-servers', controller.mcpServer.list);
  router.post('/api/mcp-servers/:id/test-connection', controller.mcpServer.testConnection);
  router.post('/api/mcp-servers/:id/execute', controller.mcpServer.execute);

  // 工作流管理
  router.post('/api/workflows', controller.workflow.create);
  router.post('/api/workflows/:workflow_id/nodes', controller.workflow.createNode);
  router.post('/api/workflows/:workflow_id/execute', controller.workflow.execute);
  router.get('/api/workflows', controller.workflow.list);
  router.get('/api/workflows/:id', controller.workflow.getById);

  // 意图管理路由
  router.post('/api/intents', controller.intent.create);
  router.get('/api/intents', controller.intent.list);
  router.get('/api/intents/:intent_id', controller.intent.detail);
  router.post('/api/intents/:intent_id/examples', controller.intent.addExample);
  router.post('/api/intents/:intent_id/train', controller.intent.train);
  router.post('/api/intents/:intent_id/predict', controller.intent.predict);
  router.post('/api/intents/:intent_id/batch-predict', controller.intent.batchPredict);
  router.post('/api/intents/:intent_id/evaluate', controller.intent.evaluate);
}; 