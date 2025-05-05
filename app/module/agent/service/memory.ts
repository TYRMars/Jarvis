import { Service } from 'egg';
import { HumanMessage, AIMessage, SystemMessage } from '@langchain/core/messages';
import { PromptTemplate } from '@langchain/core/prompts';
import { ChatOpenAI } from '@langchain/openai';
import { StructuredOutputParser } from '@langchain/core/output_parsers';
import { z } from 'zod';

interface ShortTermMemory {
  [key: string]: any;
}

// 定义记忆处理结果的结构
const memoryProcessSchema = z.object({
  importance: z.number().min(0).max(1).describe('记忆的重要性评分，范围0-1'),
  key: z.string().describe('记忆的标识键，用于检索'),
  summary: z.string().describe('记忆的简要总结'),
});

export default class MemoryService extends Service {
  // 内存中的短期记忆缓存，键为sessionId
  private shortTermMemories: Map<string, ShortTermMemory> = new Map();
  
  /**
   * 获取短期记忆
   * @param agentId Agent ID
   * @param sessionId 会话ID
   * @param key 记忆键（可选）
   */
  public async getShortTermMemory(agentId: number, sessionId: string, key?: string): Promise<any> {
    const memoryKey = `${agentId}:${sessionId}`;
    if (!this.shortTermMemories.has(memoryKey)) {
      this.shortTermMemories.set(memoryKey, {});
    }
    
    const memory = this.shortTermMemories.get(memoryKey);
    if (memory && key) {
      return memory[key];
    }
    return memory || {};
  }
  
  /**
   * 存储短期记忆
   * @param agentId Agent ID
   * @param sessionId 会话ID
   * @param key 记忆键
   * @param value 记忆值
   */
  public async setShortTermMemory(agentId: number, sessionId: string, key: string, value: any): Promise<void> {
    const memoryKey = `${agentId}:${sessionId}`;
    if (!this.shortTermMemories.has(memoryKey)) {
      this.shortTermMemories.set(memoryKey, {});
    }
    
    const memory = this.shortTermMemories.get(memoryKey);
    if (memory) {
      memory[key] = value;
    }
  }
  
  /**
   * 清除短期记忆
   * @param agentId Agent ID
   * @param sessionId 会话ID
   */
  public async clearShortTermMemory(agentId: number, sessionId: string): Promise<void> {
    const memoryKey = `${agentId}:${sessionId}`;
    this.shortTermMemories.delete(memoryKey);
  }
  
  /**
   * 获取长期记忆
   * @param agentId Agent ID
   * @param key 记忆键（可选）
   * @param limit 限制返回的记忆数量
   */
  public async getLongTermMemory(agentId: number, key?: string, limit: number = 10): Promise<any[]> {
    const whereClause: any = { agent_id: agentId };
    if (key) {
      whereClause.key = key;
    }
    
    const memories = await this.ctx.model.Memory.findAll({
      where: whereClause,
      order: [
        ['importance', 'DESC'],
        ['last_accessed', 'DESC']
      ],
      limit,
    });
    
    // 更新访问时间
    for (const memory of memories) {
      if (memory) {
        await memory.update({
          last_accessed: new Date(),
        });
      }
    }
    
    return memories;
  }
  
  /**
   * 存储长期记忆
   * @param agentId Agent ID
   * @param key 记忆键
   * @param value 记忆值
   * @param importance 重要性 (0-1)
   */
  public async setLongTermMemory(agentId: number, key: string, value: string, importance: number = 0.5): Promise<any> {
    // 查找是否已存在该键的记忆
    const existingMemory = await this.ctx.model.Memory.findOne({
      where: {
        agent_id: agentId,
        key,
      },
    });
    
    if (existingMemory) {
      // 更新现有记忆
      return await existingMemory.update({
        value,
        importance,
        last_accessed: new Date(),
      });
    } else {
      // 创建新记忆
      return await this.ctx.model.Memory.create({
        agent_id: agentId,
        key,
        value,
        importance,
        last_accessed: new Date(),
      });
    }
  }
  
  /**
   * 移除长期记忆
   * @param agentId Agent ID
   * @param key 记忆键
   */
  public async removeLongTermMemory(agentId: number, key: string): Promise<void> {
    await this.ctx.model.Memory.destroy({
      where: {
        agent_id: agentId,
        key,
      },
    });
  }
  
  /**
   * 从对话中提取并存储重要记忆
   * @param agentId Agent ID
   * @param userMessage 用户消息
   * @param aiResponse AI响应
   */
  public async processMemoryFromConversation(agentId: number, userMessage: string, aiResponse: string): Promise<void> {
    try {
      // 使用LLM分析对话，提取重要信息作为长期记忆
      const parser = StructuredOutputParser.fromZodSchema(memoryProcessSchema);
      
      const promptTemplate = PromptTemplate.fromTemplate(`
分析以下对话，判断是否包含值得长期记忆的重要信息。
如果包含重要信息，请提取并评估其重要性。

用户消息: {userMessage}
AI响应: {aiResponse}

${parser.getFormatInstructions()}

如果对话中没有包含任何值得记忆的重要信息，请将重要性评分设为0。
只有当对话中包含明确的事实、偏好、名称、日期或其他值得长期记住的信息时，才提取为记忆。
      `);
      
      const prompt = await promptTemplate.format({ userMessage, aiResponse });
      
      // 使用强大的模型分析对话
      const llm = new ChatOpenAI({
        modelName: 'gpt-4',
        temperature: 0,
        openAIApiKey: this.app.config.ai?.openai?.apiKey,
      });
      
      const response = await llm.invoke(prompt);
      const responseContent = response.content.toString();
      const parsedResponse = await parser.parse(responseContent);
      
      // 如果重要性足够，则存储为长期记忆
      if (parsedResponse.importance > 0.3) {
        await this.setLongTermMemory(
          agentId,
          parsedResponse.key,
          parsedResponse.summary,
          parsedResponse.importance
        );
      }
    } catch (error) {
      this.ctx.logger.error('处理记忆时出错:', error);
    }
  }
  
  /**
   * 获取相关记忆以增强对话上下文
   * @param agentId Agent ID
   * @param userMessage 用户消息
   */
  public async getRelevantMemories(agentId: number, userMessage: string): Promise<string> {
    try {
      // 获取所有长期记忆
      const memories = await this.getLongTermMemory(agentId);
      if (memories.length === 0) {
        return '';
      }
      
      // 使用LLM判断哪些记忆与当前对话相关
      const promptTemplate = PromptTemplate.fromTemplate(`
你是一个记忆检索系统。你需要判断哪些记忆与当前用户消息相关。

用户消息: {userMessage}

已有记忆:
{memories}

请从上述记忆中提取与当前用户消息最相关的信息，组织成简洁的文本返回。
如果没有相关记忆，请返回空字符串。
不要添加任何额外解释，只返回相关记忆的内容。
      `);
      
      const memoriesText = memories
        .map(m => `- ${m.key}: ${m.value} (重要性: ${m.importance})`)
        .join('\n');
      
      const prompt = await promptTemplate.format({
        userMessage,
        memories: memoriesText,
      });
      
      // 使用高效模型筛选记忆
      const llm = new ChatOpenAI({
        modelName: 'gpt-3.5-turbo',
        temperature: 0,
        openAIApiKey: this.app.config.ai?.openai?.apiKey,
      });
      
      const response = await llm.invoke(prompt);
      return response.content.toString();
    } catch (error) {
      this.ctx.logger.error('获取相关记忆时出错:', error);
      return '';
    }
  }
} 