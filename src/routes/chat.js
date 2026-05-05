const express = require('express');
const router = express.Router();
const axios = require('axios');
const supabase = require('../services/supabase');
const { getEmbedding } = require('../services/embedding');
const { analyzeEmotion, summarize } = require('../services/llm');
const { calculateDecayScore } = require('../utils/decay');

// 对话历史（内存存储，重启后清空）
let conversationHistory = [];

// 系统提示词
const SYSTEM_PROMPT = require('../config/prompt');



// 对话接口
router.post('/', async (req, res) => {
  try {
    // 兼容OpenAI格式
const messages = req.body.messages;
const message = messages && messages.length > 0 
  ? messages[messages.length - 1].content 
  : req.body.message;

    
// 1. 检索相关记忆
const queryEmbedding = await getEmbedding(message);
const embeddingStr = `[${queryEmbedding.join(',')}]`;

const { data: relatedMemories, error } = await supabase
  .rpc('match_memories', {
    query_embedding: embeddingStr,
    match_threshold: 0.3,
    match_count: 10
  });

if (error) {
  console.error('检索记忆失败:', error);
}

    
// 2. 构建记忆提示
    let memoryPrompt = '';
    if (relatedMemories && relatedMemories.length > 0) {
      const memoryTexts = relatedMemories
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, 3)
        .map(m => `- ${m.content}`)
        .join('\n');
      memoryPrompt = `\n\n[相关记忆 - 必须基于这些记忆回答，不要编造]\n${memoryTexts}`;
    }

// 3. 构建消息列表
    const userPrompt = memoryPrompt 
      ? `[重要提醒：上面提供了相关记忆，只使用这些记忆回答。不要添加任何记忆里没有的细节。]\n\n${message}`
      : message;
    
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT + memoryPrompt },
      ...conversationHistory.slice(-10),
      { role: 'user', content: userPrompt }
    ];

    
// 4. 调用LLM
    const response = await axios.post(
      `${process.env.SILICON_BASE_URL}/chat/completions`,
      {
        model: 'Qwen/Qwen2.5-14B-Instruct',
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
    
    // 5. 更新对话历史
    conversationHistory.push(
      { role: 'user', content: message },
      { role: 'assistant', content: reply }
    );
    
    // 6. 异步存储记忆（不阻塞回复）
    storeMemory(message, 'user');
    storeMemory(reply, 'assistant');
    
    // 7. 返回回复
    res.json({ success: true, reply, memories: relatedMemories?.length || 0 });
    
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 清空对话历史
router.delete('/history', (req, res) => {
  conversationHistory = [];
  res.json({ success: true });
});

// 获取模型列表
router.get('/models', (req, res) => {
  res.json({
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
