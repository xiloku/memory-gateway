const express = require('express');
const router = express.Router();
const supabase = require('../services/supabase');
const { getEmbedding } = require('../services/embedding');
const { analyzeEmotion, summarize } = require('../services/llm');
const { calculateDecayScore } = require('../utils/decay');

// 存储新记忆
router.post('/', async (req, res) => {
  try {
    const { content } = req.body;
    
    // 并行处理：向量、情感、摘要
    const [embedding, emotion, summary] = await Promise.all([
      getEmbedding(content),
      analyzeEmotion(content),
      summarize(content)
    ]);
    
    const embeddingStr = `[${embedding.join(',')}]`;
    
    const { data, error } = await supabase
      .from('memories')
      .insert({
        content,
        summary,
        embedding: embeddingStr,
        valence: emotion.valence,
        arousal: emotion.arousal,
        domain: emotion.domain,
        importance: emotion.importance
      })
      .select();
    
    if (error) throw error;
    res.json({ success: true, data: data[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// 检索相关记忆
router.get('/search', async (req, res) => {
  try {
    const { query, threshold = 0.7, limit = 20 } = req.query;
    
    const queryEmbedding = await getEmbedding(query);
    
        const { data, error } = await supabase
      .rpc('match_memories', {
        query_embedding: `[${queryEmbedding.join(',')}]`,
        match_threshold: parseFloat(threshold),
        match_count: parseInt(limit)
      });

    
    if (error) throw error;
    
    // 更新访问计数
    if (data && data.length > 0) {
      const ids = data.map(m => m.id);
      await supabase.rpc('increment_access', { memory_ids: ids });
    }
    
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dreaming：整理记忆
router.post('/dreaming', async (req, res) => {
  try {
    // 获取所有未归档记忆
    const { data: memories, error } = await supabase
      .from('memories')
      .select('*')
      .eq('is_feel', false)
      .eq('is_pinned', false);
    
    if (error) throw error;
    
    // 计算衰减分数并更新
    const updates = [];
    for (const mem of memories) {
      const decayScore = calculateDecayScore(mem);
      updates.push(
        supabase
          .from('memories')
          .update({ decay_score: decayScore })
          .eq('id', mem.id)
      );
    }
    
    await Promise.all(updates);
    
    // 归档低分记忆
    const { error: archiveError } = await supabase
      .from('memories')
      .update({ is_digested: true })
      .lt('decay_score', 0.1)
      .eq('is_pinned', false);
    
    if (archiveError) throw archiveError;
    
    res.json({ success: true, processed: memories.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 更新记忆
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    
    const { data, error } = await supabase
      .from('memories')
      .update(updates)
      .eq('id', id)
      .select();
    
    if (error) throw error;
    res.json({ success: true, data: data[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 删除记忆
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const { error } = await supabase
      .from('memories')
      .delete()
      .eq('id', id);
    
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
