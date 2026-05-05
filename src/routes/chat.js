const express = require('express');
const router = express.Router();
const axios = require('axios');
const supabase = require('../services/supabase');
const { getEmbedding } = require('../services/embedding');
const { analyzeEmotion, summarize } = require('../services/llm');

// 对话历史（内存存储，重启后清空）
let conversationHistory = [];

// 系统提示词
const SYSTEM_PROMPT = require('../config/prompt');

// 对话接口 - 兼容OpenAI格式 + 流式响应
router.post('/', async (req, res) => {
  try {
    const { messages: reqMessages, model, stream } = req.body;
    
    // 兼容OpenAI格式：从messages数组提取最后一条用户消息
    const lastMessage = reqMessages && reqMessages.length > 0 
      ? reqMessages[reqMessages.length - 1].content 
      : '';
    
    if (!lastMessage) {
      return res.status(400).json({ error: { message: "No message provided" } });
    }
    
    // 1. 检索相关记忆
    let memoryPrompt = '';
    try {
      const queryEmbedding = await getEmbedding(lastMessage);
      const embeddingStr = `[${queryEmbedding.join(',')}]`;

      const { data: relatedMemories, error } = await supabase
        .rpc('match_memories', {
          query_embedding: embeddingStr,
          match_threshold: 0.3,
          match_count: 10
        });

      if (!error && relatedMemories && relatedMemories.length > 0) {
        const memoryTexts = relatedMemories
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, 3)
          .map(m => `- ${m.content}`)
          .join('\n');
        memoryPrompt = `\n\n[相关记忆 - 必须基于这些记忆回答，不要编造]\n${memoryTexts}`;
      }
    } catch (err) {
      console.error('检索记忆失败:', err.message);
    }

    // 2. 构建消息列表
    const userPrompt = memoryPrompt 
      ? `[重要提醒：上面提供了相关记忆，只使用这些记忆回答。不要添加任何记忆里没有的细节。]\n\n${lastMessage}`
      : lastMessage;
    
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT + memoryPrompt },
      ...conversationHistory.slice(-10),
      { role: 'user', content: userPrompt }
    ];

    // 3. 调用LLM
    const modelName = model || 'Qwen/Qwen2.5-14B-Instruct';
    
    if (stream) {
      // 流式响应
      const response = await axios.post(
        `${process.env.SILICON_BASE_URL}/chat/completions`,
        {
          model: modelName,
          messages,
          temperature: 0.5,
          repetition_penalty: 1.1,
          stream: true
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.SILICON_API_KEY}`,
            'Content-Type': 'application/json'
          },
          responseType: 'stream'
        }
      );

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      response.data.on('data', (chunk) => {
        res.write(chunk);
      });

      response.data.on('end', () => {
        res.end();
      });
    } else {
      // 非流式响应
      const response = await axios.post(
        `${process.env.SILICON_BASE_URL}/chat/completions`,
        {
          model: modelName,
          messages,
          temperature: 0.5,
          repetition_penalty: 1.1
        },
        {
          headers: {
            'Authorization': `Bearer ${process.env.SILICON_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      const reply = response.data.choices[0].message.content;
      
      // 更新对话历史
      conversationHistory.push(
        { role: 'user', content: lastMessage },
        { role: 'assistant', content: reply }
      );
      
      // 异步存储记忆
      storeMemory(lastMessage, 'user');
      storeMemory(reply, 'assistant');
      
      // 返回OpenAI兼容格式
      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: modelName,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: reply
          },
          finish_reason: 'stop'
        }],
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      });
    }
    
  } catch (err) {
    console.error('Chat error:', err.response?.data || err.message);
    res.status(500).json({ 
      error: { 
        message: err.response?.data?.error?.message || err.message,
        type: err.response?.data?.error?.type || 'internal_error',
        details: err.response?.data || null
      } 
    });
  }
});

// 清空对话历史
router.delete('/history', (req, res) => {
  conversationHistory = [];
  res.json({ success: true });
});

// 获取模型列表 - OpenAI兼容格式
router.get('/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'Qwen/Qwen2.5-14B-Instruct', object: 'model', owned_by: 'siliconflow' }
    ]
  });
});

// 异步存储记忆
async function storeMemory(content, role) {
  try {
    const [embedding, emotion, summary] = await Promise.all([
      getEmbedding(content),
      analyzeEmotion(content),
      summarize(content)
    ]);
    
    await supabase.from('memories').insert({
      content,
      summary,
      embedding,
      valence: emotion.valence,
      arousal: emotion.arousal,
      domain: emotion.domain,
      importance: emotion.importance,
      source_bucket_id: role
    });
  } catch (err) {
    console.error('存储记忆失败:', err.message);
  }
}

module.exports = router;
