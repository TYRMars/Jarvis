import { Service } from 'egg';
import { FaissStore } from '@langchain/community/vectorstores/faiss';
import { OpenAIEmbeddings } from '@langchain/openai';
import { Document } from '@langchain/core/documents';
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import * as fs from 'fs';
import * as path from 'path';

export default class VectorStoreService extends Service {
  private readonly baseDir = path.join(this.app.baseDir, 'knowledge_base');
  private readonly openaiApiKey = this.app.config.openai.apiKey;
  private readonly embeddingModel = new OpenAIEmbeddings({
    openAIApiKey: this.openaiApiKey,
    modelName: 'text-embedding-3-small',
  });

  /**
   * 创建知识库向量存储
   */
  public async create(knowledgeBases: any[]) {
    // 确保基础目录存在
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }

    const documents: Document[] = [];

    // 处理每个知识库
    for (const kb of knowledgeBases) {
      const config = JSON.parse(kb.config);
      
      switch (kb.type) {
        case 'file':
          const fileDocuments = await this.processFileKnowledgeBase(kb, config);
          documents.push(...fileDocuments);
          break;
        case 'text':
          const textDocuments = this.processTextKnowledgeBase(kb, config);
          documents.push(...textDocuments);
          break;
        case 'database':
          const dbDocuments = await this.processDatabaseKnowledgeBase(kb, config);
          documents.push(...dbDocuments);
          break;
        case 'api':
          const apiDocuments = await this.processApiKnowledgeBase(kb, config);
          documents.push(...apiDocuments);
          break;
        default:
          this.ctx.logger.warn(`Unsupported knowledge base type: ${kb.type}`);
      }
    }

    // 创建向量存储
    if (documents.length === 0) {
      throw new Error('No documents found in the knowledge base');
    }

    // 使用FAISS存储向量
    const vectorStore = await FaissStore.fromDocuments(documents, this.embeddingModel);
    
    // 保存向量存储到磁盘（可选）
    const storePath = path.join(this.baseDir, 'vector_store');
    await vectorStore.save(storePath);
    
    return vectorStore;
  }

  /**
   * 加载知识库向量存储
   */
  public async load(storeName: string) {
    const storePath = path.join(this.baseDir, storeName);
    if (!fs.existsSync(storePath)) {
      throw new Error(`Vector store not found: ${storeName}`);
    }
    
    return await FaissStore.load(storePath, this.embeddingModel);
  }

  /**
   * 处理文件类型的知识库
   */
  private async processFileKnowledgeBase(kb: any, config: any): Promise<Document[]> {
    const { paths, recursive = false } = config;
    const documents: Document[] = [];
    
    // 处理每个路径
    for (const p of paths) {
      const fullPath = path.isAbsolute(p) ? p : path.join(this.baseDir, p);
      
      if (!fs.existsSync(fullPath)) {
        this.ctx.logger.warn(`Path not found: ${fullPath}`);
        continue;
      }
      
      if (fs.statSync(fullPath).isDirectory()) {
        // 处理目录
        const files = this.getFilesInDirectory(fullPath, recursive);
        for (const file of files) {
          const fileDocuments = await this.processFile(file, kb.id);
          documents.push(...fileDocuments);
        }
      } else {
        // 处理单个文件
        const fileDocuments = await this.processFile(fullPath, kb.id);
        documents.push(...fileDocuments);
      }
    }
    
    return documents;
  }

  /**
   * 处理文本类型的知识库
   */
  private processTextKnowledgeBase(kb: any, config: any): Document[] {
    const { texts } = config;
    const documents: Document[] = [];
    
    // 处理每段文本
    for (const text of texts) {
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1000,
        chunkOverlap: 200,
      });
      
      const textDocuments = splitter.createDocuments([text], [{ 
        source: `knowledge_base_${kb.id}_text_${texts.indexOf(text)}`,
        knowledge_base_id: kb.id,
      }]);
      
      documents.push(...textDocuments);
    }
    
    return documents;
  }

  /**
   * 处理数据库类型的知识库
   */
  private async processDatabaseKnowledgeBase(kb: any, config: any): Promise<Document[]> {
    const { query, params = {}, textFields } = config;
    const documents: Document[] = [];
    
    // 执行查询
    const results = await this.ctx.model.query(query, {
      replacements: params,
      type: this.ctx.model.QueryTypes.SELECT,
    });
    
    // 对每个结果，将指定字段的内容转换为文档
    for (const result of results) {
      // 提取文本内容
      let content = '';
      for (const field of textFields) {
        if (result[field]) {
          content += `${field}: ${result[field]}\n`;
        }
      }
      
      if (content.trim()) {
        const splitter = new RecursiveCharacterTextSplitter({
          chunkSize: 1000,
          chunkOverlap: 200,
        });
        
        const dbDocuments = splitter.createDocuments([content], [{
          source: `knowledge_base_${kb.id}_db_${results.indexOf(result)}`,
          knowledge_base_id: kb.id,
          record_id: result.id || results.indexOf(result),
        }]);
        
        documents.push(...dbDocuments);
      }
    }
    
    return documents;
  }

  /**
   * 处理API类型的知识库
   */
  private async processApiKnowledgeBase(kb: any, config: any): Promise<Document[]> {
    const { url, method = 'GET', headers = {}, data = {}, responseField, idField } = config;
    const documents: Document[] = [];
    
    // 调用API
    const response = await this.ctx.curl(url, {
      method,
      headers,
      data,
      dataType: 'json',
    });
    
    if (!response.data) {
      throw new Error(`API call failed: ${url}`);
    }
    
    // 提取响应数据
    let items = response.data;
    if (responseField) {
      items = response.data[responseField];
    }
    
    if (!Array.isArray(items)) {
      items = [items];
    }
    
    // 处理每个项目
    for (const item of items) {
      // 将对象转换为文本
      const content = this.objectToText(item);
      
      if (content.trim()) {
        const splitter = new RecursiveCharacterTextSplitter({
          chunkSize: 1000,
          chunkOverlap: 200,
        });
        
        const apiDocuments = splitter.createDocuments([content], [{
          source: `knowledge_base_${kb.id}_api_${idField ? item[idField] : items.indexOf(item)}`,
          knowledge_base_id: kb.id,
          item_id: idField ? item[idField] : items.indexOf(item),
        }]);
        
        documents.push(...apiDocuments);
      }
    }
    
    return documents;
  }

  /**
   * 处理单个文件
   */
  private async processFile(filePath: string, knowledgeBaseId: number): Promise<Document[]> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const splitter = new RecursiveCharacterTextSplitter({
      chunkSize: 1000,
      chunkOverlap: 200,
    });
    
    return splitter.createDocuments([content], [{
      source: filePath,
      knowledge_base_id: knowledgeBaseId,
    }]);
  }

  /**
   * 获取目录中的所有文件
   */
  private getFilesInDirectory(dir: string, recursive: boolean): string[] {
    const files: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory() && recursive) {
        const subdirFiles = this.getFilesInDirectory(fullPath, recursive);
        files.push(...subdirFiles);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
    
    return files;
  }

  /**
   * 将对象转换为文本格式
   */
  private objectToText(obj: Record<string, any>, prefix = ''): string {
    let text = '';
    
    for (const [key, value] of Object.entries(obj)) {
      const formattedKey = prefix ? `${prefix}.${key}` : key;
      
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // 递归处理嵌套对象
        text += this.objectToText(value, formattedKey);
      } else if (Array.isArray(value)) {
        // 处理数组
        for (let i = 0; i < value.length; i++) {
          if (typeof value[i] === 'object' && value[i] !== null) {
            text += this.objectToText(value[i], `${formattedKey}[${i}]`);
          } else {
            text += `${formattedKey}[${i}]: ${value[i]}\n`;
          }
        }
      } else {
        // 处理基本类型
        text += `${formattedKey}: ${value}\n`;
      }
    }
    
    return text;
  }

  /**
   * 向量相似性搜索
   */
  public async search(vectorStore: any, query: string, limit = 5) {
    return await vectorStore.similaritySearch(query, limit);
  }

  /**
   * 混合搜索（关键词+向量）
   */
  public async hybridSearch(vectorStore: any, query: string, limit = 5) {
    return await vectorStore.asRetriever({
      searchType: 'hybrid',
      k: limit,
    }).getRelevantDocuments(query);
  }
} 