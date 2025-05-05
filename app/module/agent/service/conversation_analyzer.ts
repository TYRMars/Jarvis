import { Service } from 'egg';
import { PromptTemplate } from '@langchain/core/prompts';
import { StructuredOutputParser } from '@langchain/core/output_parsers';
import { z } from 'zod';

const conversationAnalysisSchema = z.object({
  topic: z.string().describe('对话主题'),
  key_points: z.array(z.string()).describe('关键讨论点列表'),
  sentiment_score: z.number().min(-1).max(1).describe('情感分析得分，范围从-1到1'),
  user_satisfaction: z.number().min(0).max(10).describe('用户满意度评分，范围从0到10'),
  questions_asked: z.number().min(0).describe('用户提问的数量'),
  issues_resolved: z.number().min(0).describe('成功解决的问题数量'),
  analysis_summary: z.string().describe('对话分析总结'),
});

export default class ConversationAnalyzerService extends Service {
  /**
   * 分析对话
   */
  public async analyzeConversation(agentId: number, sessionId: string) {
    try {
      // 获取对话历史
      const conversations = await this.ctx.model.Conversation.findAll({
        where: {
          agent_id: agentId,
          session_id: sessionId,
        },
        order: [['created_at', 'ASC']],
      });
      
      if (conversations.length === 0) {
        throw new Error('没有找到对话历史');
      }
      
      // 创建结构化输出解析器
      const parser = StructuredOutputParser.fromZodSchema(conversationAnalysisSchema);
      
      // 创建分析提示模板
      const analysisTemplate = PromptTemplate.fromTemplate(`
你是一个专业的对话分析专家。请对以下对话内容进行全面分析。

对话历史：
${this.formatConversations(conversations)}

请基于对话内容进行分析，包括但不限于：
1. 对话主题
2. 关键讨论点
3. 情感分析
4. 用户满意度评估
5. 用户提问数量
6. 成功解决的问题数量
7. 总体分析摘要

${parser.getFormatInstructions()}
      `);
      
      // 生成分析提示
      const prompt = await analysisTemplate.format({});
      
      // 使用LLM分析
      const rawAnalysis = await this.ctx.service.ai.generate({
        prompt,
        model: 'gpt-4',
        provider: 'openai',
        temperature: 0.2,
      });
      
      // 解析结构化输出
      const analysis = await parser.parse(rawAnalysis);
      
      // 保存分析结果
      const analysisRecord = await this.ctx.model.ConversationAnalysis.create({
        agent_id: agentId,
        session_id: sessionId,
        conversation_length: conversations.length,
        topic: analysis.topic,
        key_points: JSON.stringify(analysis.key_points),
        sentiment_score: analysis.sentiment_score,
        user_satisfaction: analysis.user_satisfaction,
        questions_asked: analysis.questions_asked,
        issues_resolved: analysis.issues_resolved,
        analysis_summary: analysis.analysis_summary,
      });
      
      return analysisRecord;
    } catch (error: any) {
      this.ctx.logger.error('[ConversationAnalyzerService] analyzeConversation error:', error);
      throw new Error(`分析对话失败: ${error.message}`);
    }
  }
  
  /**
   * 获取Agent的所有对话分析
   */
  public async getAnalysisByAgent(agentId: number, page = 1, pageSize = 10) {
    const { count, rows } = await this.ctx.model.ConversationAnalysis.findAndCountAll({
      where: { agent_id: agentId },
      order: [['created_at', 'DESC']],
      offset: (page - 1) * pageSize,
      limit: pageSize,
    });
    
    return {
      total: count,
      items: rows,
    };
  }
  
  /**
   * 获取会话的对话分析
   */
  public async getAnalysisBySession(agentId: number, sessionId: string) {
    const analysis = await this.ctx.model.ConversationAnalysis.findOne({
      where: {
        agent_id: agentId,
        session_id: sessionId,
      },
    });
    
    if (!analysis) {
      // 如果没有分析记录，创建一个新的
      return await this.analyzeConversation(agentId, sessionId);
    }
    
    return analysis;
  }
  
  /**
   * 获取Agent对话分析统计
   */
  public async getAgentAnalyticsStats(agentId: number) {
    // 获取最近30天的对话分析
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const analyses = await this.ctx.model.ConversationAnalysis.findAll({
      where: {
        agent_id: agentId,
        created_at: {
          [this.app.Sequelize.Op.gte]: thirtyDaysAgo,
        },
      },
    });
    
    if (analyses.length === 0) {
      return {
        total_conversations: 0,
        average_satisfaction: 0,
        average_sentiment: 0,
        total_questions: 0,
        issues_resolved_rate: 0,
        topics: [],
      };
    }
    
    // 计算统计数据
    let totalSatisfaction = 0;
    let totalSentiment = 0;
    let totalQuestions = 0;
    let totalIssues = 0;
    const topicsCount: Record<string, number> = {};
    
    analyses.forEach(analysis => {
      totalSatisfaction += analysis.user_satisfaction;
      totalSentiment += analysis.sentiment_score;
      totalQuestions += analysis.questions_asked;
      totalIssues += analysis.issues_resolved;
      
      // 统计主题
      const topic = analysis.topic.trim();
      topicsCount[topic] = (topicsCount[topic] || 0) + 1;
    });
    
    // 排序主题
    const topicsSorted = Object.entries(topicsCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic, count]) => ({ topic, count }));
    
    return {
      total_conversations: analyses.length,
      average_satisfaction: totalSatisfaction / analyses.length,
      average_sentiment: totalSentiment / analyses.length,
      total_questions: totalQuestions,
      issues_resolved_rate: totalQuestions ? totalIssues / totalQuestions : 0,
      topics: topicsSorted,
    };
  }
  
  /**
   * 格式化对话历史
   */
  private formatConversations(conversations: any[]) {
    return conversations.map((conv, index) => {
      return `[回合${index + 1}]
用户: ${conv.user_input}
AI助手: ${conv.agent_response || '(处理中...)'}
`;
    }).join('\n');
  }
} 