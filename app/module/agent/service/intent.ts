import { Service } from 'egg';
import { ChatOpenAI } from 'langchain/chat_models/openai';
import { ChatPromptTemplate } from 'langchain/prompts';
import { RunnableSequence } from 'langchain/schema/runnable';
import { StringOutputParser } from 'langchain/schema/output_parser';

export default class IntentService extends Service {
  // 创建意图
  async create(params: {
    user_id: number;
    name: string;
    description?: string;
    type: string;
    config: any;
  }) {
    const intent = await this.ctx.model.Intent.create({
      ...params,
      status: 0,
    });
    return intent;
  }

  // 添加训练样本
  async addExample(params: {
    intent_id: number;
    text: string;
    entities?: any;
    metadata?: any;
  }) {
    const example = await this.ctx.model.IntentExample.create(params);
    return example;
  }

  // 训练意图分类器
  async train(intent_id: number) {
    const intent = await this.ctx.model.Intent.findByPk(intent_id);
    if (!intent) {
      throw new Error('意图不存在');
    }

    // 更新状态为训练中
    await intent.update({ status: 1 });

    try {
      const examples = await this.ctx.model.IntentExample.findAll({
        where: { intent_id },
      });

      // 构建训练数据
      const trainingData = examples.map(example => ({
        text: example.text,
        intent: intent.name,
        entities: example.entities,
      }));

      // 使用LangChain训练分类器
      const model = new ChatOpenAI({
        modelName: intent.config.model_name || 'gpt-3.5-turbo',
        temperature: intent.config.temperature || 0.7,
      });

      const prompt = ChatPromptTemplate.fromTemplate(`
        请根据以下训练数据学习意图分类：
        {training_data}
        
        输出格式：
        {
          "model_info": {
            "version": "1.0",
            "training_time": "2024-01-01T00:00:00Z",
            "metrics": {
              "accuracy": 0.95,
              "precision": 0.94,
              "recall": 0.96
            }
          }
        }
      `);

      const chain = RunnableSequence.from([
        prompt,
        model,
        new StringOutputParser(),
      ]);

      const result = await chain.invoke({
        training_data: JSON.stringify(trainingData),
      });

      // 更新意图状态和模型信息
      await intent.update({
        status: 2,
        model_info: JSON.parse(result),
        training_data: trainingData,
      });

      return intent;
    } catch (error) {
      // 更新状态为训练失败
      await intent.update({ status: 3 });
      throw error;
    }
  }

  // 预测意图
  async predict(intent_id: number, text: string) {
    const intent = await this.ctx.model.Intent.findByPk(intent_id);
    if (!intent) {
      throw new Error('意图不存在');
    }

    if (intent.status !== 2) {
      throw new Error('意图分类器未训练完成');
    }

    const model = new ChatOpenAI({
      modelName: intent.config.model_name || 'gpt-3.5-turbo',
      temperature: intent.config.temperature || 0.7,
    });

    const prompt = ChatPromptTemplate.fromTemplate(`
      请分析以下文本的意图：
      {text}
      
      训练数据：
      {training_data}
      
      输出格式：
      {
        "intent": "意图名称",
        "confidence": 0.95,
        "entities": [],
        "reason": "分析原因"
      }
    `);

    const chain = RunnableSequence.from([
      prompt,
      model,
      new StringOutputParser(),
    ]);

    const result = await chain.invoke({
      text,
      training_data: JSON.stringify(intent.training_data),
    });

    return JSON.parse(result);
  }

  // 批量预测
  async batchPredict(intent_id: number, texts: string[]) {
    const results = await Promise.all(
      texts.map(text => this.predict(intent_id, text))
    );
    return results;
  }

  // 评估意图分类器
  async evaluate(intent_id: number, test_data: any[]) {
    const intent = await this.ctx.model.Intent.findByPk(intent_id);
    if (!intent) {
      throw new Error('意图不存在');
    }

    if (intent.status !== 2) {
      throw new Error('意图分类器未训练完成');
    }

    const predictions = await this.batchPredict(
      intent_id,
      test_data.map(item => item.text)
    );

    // 计算评估指标
    const metrics = this.calculateMetrics(predictions, test_data);

    return {
      intent_id,
      metrics,
      predictions,
    };
  }

  // 计算评估指标
  private calculateMetrics(predictions: any[], test_data: any[]) {
    let correct = 0;
    let total = test_data.length;

    for (let i = 0; i < total; i++) {
      if (predictions[i].intent === test_data[i].intent) {
        correct++;
      }
    }

    return {
      accuracy: correct / total,
      total_samples: total,
      correct_predictions: correct,
    };
  }
} 