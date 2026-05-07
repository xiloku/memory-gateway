// server.js
import Fastify from 'fastify';
import SYSTEM_PROMPT from './src/config/prompt.js';  // 这一行是修改重点

// 加载系统提示词（prompt.js）

const fastify = Fastify({ logger: true });

// ================== 工具函数 ==================
const safeFetch = async (url, options = {}, timeout = 30000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errorText.slice(0, 200)}`);
    }
    return res;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request to ${url} timed out after ${timeout}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};

function calculateDecayScore(importance, arousal, isPinned, isResolved, isDigested) {
  if (isPinned) return 999.0;
  if (isDigested) return 0.02;
  if (isResolved) return 0.05;
  const emotionWeight = 1.0 + arousal * 0.8;
  const urgencyBoost = (arousal > 0.7 && !isResolved) ? 1.5 : 1.0;
  return importance * emotionWeight * urgencyBoost;
}

async function getEmbedding(text, apiKey) {
  const response = await safeFetch('https://api.siliconflow.cn/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'Pro/BAAI/bge-m3',
      input: text,
    }),
  }, 45000);
  const data = await response.json();
  return data.data[0].embedding;
}

async function saveContext(messages, env) {
  for (const msg of messages) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      await safeFetch(`${env.SUPABASE_URL}/rest/v1/conversations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': env.SUPABASE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_KEY}`,
        },
        body: JSON.stringify({ role: msg.role, content: msg.content }),
      }).catch(e => console.error('Context save failed:', e.message));
    }
  }
  await safeFetch(`${env.SUPABASE_URL}/rest/v1/rpc/clean_old_conversations`, {
    method: 'POST',
    headers: {
      'apikey': env.SUPABASE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_KEY}`,
    },
  }).catch(e => console.error('Context clean failed:', e.message));
}

async function saveMemories(content, env) {
  console.log('=== saveMemories called ===');
  const blockStart = '<memory>';
  const blockEnd = '</memory>';
  const startIdx = content.indexOf(blockStart);
  if (startIdx === -1) return;
  const endIdx = content.indexOf(blockEnd, startIdx);
  if (endIdx === -1) return;
  const block = content.substring(startIdx + blockStart.length, endIdx).trim();
  if (!block) return;
  const lines = block.split('\n').map(l => l.trim()).filter(l => l);

  let processed = 0;
  const MAX_MEMORIES_PER_REQUEST = 5;

  for (const line of lines) {
    if (processed >= MAX_MEMORIES_PER_REQUEST) break;
    if (line.startsWith('//')) continue;
    if (!line.startsWith('-') && !line.startsWith('•') && !line.startsWith('*')) continue;

    try {
      const lineContent = line.replace(/^[-•*]\s*/, '');

      // --- UPDATE ---
      const updateMatch = lineContent.match(/\[UPDATE:(\d+)\](.+)/);
      if (updateMatch) {
        const id = parseInt(updateMatch[1]);
        const newContent = updateMatch[2].trim();
        const embedding = await getEmbedding(newContent, env.SILICON_API_KEY);
        const updateData = { content: newContent, embedding, updated_at: new Date().toISOString() };

        // 解析所有可能标签
        const valenceMatch = lineContent.match(/\[V:([\d.]+)\]/);
        if (valenceMatch) updateData.valence = parseFloat(valenceMatch[1]);
        const arousalMatch = lineContent.match(/\[A:([\d.]+)\]/);
        if (arousalMatch) updateData.arousal = parseFloat(arousalMatch[1]);
        const importanceMatch = lineContent.match(/\[I:(\d+)\]/);
        if (importanceMatch) updateData.importance = parseInt(importanceMatch[1]);
        const domainMatch = lineContent.match(/\[D:([^\]]+)\]/);
        if (domainMatch) updateData.domain = domainMatch[1];
        const tagsMatch = lineContent.match(/\[T:([^\]]+)\]/);
        if (tagsMatch) updateData.tags = tagsMatch[1];
        const resolvedMatch = lineContent.match(/\[R:(true|false)\]/);
        if (resolvedMatch) {
          updateData.is_resolved = resolvedMatch[1] === 'true';
          updateData.resolved = updateData.is_resolved;
        }
        const feelMatch = lineContent.match(/\[F:(true|false)\]/);
        if (feelMatch) updateData.is_feel = feelMatch[1] === 'true';
        const pinnedMatch = lineContent.match(/\[P:(true|false)\]/);
        if (pinnedMatch) {
          updateData.is_pinned = pinnedMatch[1] === 'true';
          if (updateData.is_pinned) updateData.importance = 10;
        }
        const digestedMatch = lineContent.match(/\[DG:(true|false)\]/);
        if (digestedMatch) updateData.is_digested = digestedMatch[1] === 'true';
        const sourceMatch = lineContent.match(/\[S:([^\]]+)\]/);
        if (sourceMatch) updateData.source_bucket_id = sourceMatch[1];

        // 重新计算衰减分数
        const currentImportance = updateData.importance || 5;
        const currentArousal = updateData.arousal || 0.5;
        const currentIsPinned = updateData.is_pinned || false;
        const currentIsResolved = updateData.is_resolved || false;
        const currentIsDigested = updateData.is_digested || false;
        updateData.decay_score = calculateDecayScore(currentImportance, currentArousal, currentIsPinned, currentIsResolved, currentIsDigested);

        await safeFetch(`${env.SUPABASE_URL}/rest/v1/memories?id=eq.${id}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`,
          },
          body: JSON.stringify(updateData),
        });
        processed++;
        continue;
      }

      // --- DELETE ---
      const deleteMatch = lineContent.match(/\[DELETE:(\d+)\]/);
      if (deleteMatch) {
        const id = parseInt(deleteMatch[1]);
        await safeFetch(`${env.SUPABASE_URL}/rest/v1/memories?id=eq.${id}`, {
          method: 'DELETE',
          headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`,
          },
        });
        processed++;
        continue;
      }

      // --- ADD (完整新格式) ---
      const addMatch = lineContent.match(/\[(\d{4}-\d{2}-\d{2})\]\[V:([\d.]+)\]\[A:([\d.]+)\]\[I:(\d+)\](?:\[D:([^\]]+)\])?(?:\[T:([^\]]+)\])?(?:\[F:(true|false)\])?(?:\[P:(true|false)\])?(?:\[R:(true|false)\])?(?:\[DG:(true|false)\])?(?:\[S:([^\]]+)\])?(.+)/);
      if (addMatch) {
        const date = addMatch[1];
        const valence = parseFloat(addMatch[2]);
        const arousal = parseFloat(addMatch[3]);
        const importance = parseInt(addMatch[4]);
        const domain = addMatch[5] || null;
        const tags = addMatch[6] || null;
        const isFeel = addMatch[7] === 'true';
        const isPinned = addMatch[8] === 'true';
        const isResolved = addMatch[9] === 'true';
        const isDigested = addMatch[10] === 'true';
        const sourceBucketId = addMatch[11] || null;
        const newContent = addMatch[12].trim();

        const embedding = await getEmbedding(newContent, env.SILICON_API_KEY);
        const decayScore = calculateDecayScore(importance, arousal, isPinned, isResolved, isDigested);

        await safeFetch(`${env.SUPABASE_URL}/rest/v1/memories`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`,
          },
          body: JSON.stringify({
            content: newContent,
            date,
            embedding,
            valence,
            arousal,
            importance,
            domain,
            tags,
            is_resolved: isResolved,
            resolved: isResolved,
            is_pinned: isPinned,
            is_feel: isFeel,
            is_digested: isDigested,
            source_bucket_id: sourceBucketId,
            activation_count: 0,
            access_count: 0,
            decay_score: decayScore,
            weight: decayScore,
            last_accessed_at: new Date().toISOString(),
          }),
        });
        processed++;
        continue;
      }

      // --- 兼容旧格式 ---
      const oldAddMatch = lineContent.match(/\[(\d{4}-\d{2}-\d{2})\](.+)/);
      if (oldAddMatch) {
        const date = oldAddMatch[1];
        const newContent = oldAddMatch[2].trim();
        const embedding = await getEmbedding(newContent, env.SILICON_API_KEY);
        const decayScore = calculateDecayScore(5, 0.5, false, false, false);
        await safeFetch(`${env.SUPABASE_URL}/rest/v1/memories`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`,
          },
          body: JSON.stringify({
            content: newContent,
            date,
            embedding,
            valence: 0.5,
            arousal: 0.5,
            importance: 5,
            domain: null,
            tags: null,
            is_resolved: false,
            resolved: false,
            is_pinned: false,
            is_feel: false,
            is_digested: false,
            source_bucket_id: null,
            activation_count: 0,
            access_count: 0,
            decay_score: decayScore,
            weight: decayScore,
            last_accessed_at: new Date().toISOString(),
          }),
        });
        processed++;
      }
    } catch (innerError) {
      console.error('Save memory entry error:', innerError.message);
    }
  }
}

// ================== 主路由 ==================
fastify.post('/v1/chat/completions', async (request, reply) => {
  const { messages, stream = false } = request.body;

  // 1. 系统提示
  const now = new Date();
  const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  let systemContent = SYSTEM_PROMPT + `\n[当前时间: ${timeStr}]`;

  // 2. 检索记忆
  const queryText = messages.filter(m => m.role === 'user').pop()?.content || '';
  let memoryContext = '';
  let memoryIds = [];
  if (queryText) {
    try {
      const queryEmbedding = await getEmbedding(queryText, process.env.SILICON_API_KEY);
      const matchResponse = await safeFetch(
        `${process.env.SUPABASE_URL}/rest/v1/rpc/match_memories`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': process.env.SUPABASE_KEY,
            'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
          },
          body: JSON.stringify({ query_embedding: queryEmbedding, match_count: 10, match_threshold: 0.4 }),
        },
        15000
      );
      const memories = await matchResponse.json();
      if (Array.isArray(memories) && memories.length > 0) {
        memories.sort((a, b) => {
          if (a.is_pinned && !b.is_pinned) return -1;
          if (!a.is_pinned && b.is_pinned) return 1;
          if (!a.is_resolved && b.is_resolved) return -1;
          if (a.is_resolved && !b.is_resolved) return 1;
          return (b.decay_score || 0) - (a.decay_score || 0);
        });
        memoryContext = memories.map(m => {
          let line = `${m.id}.[${m.date}]${m.content}`;
          if (m.domain) line += ` [${m.domain}]`;
          if (m.is_feel) line += ' [Feel]';
          if (m.is_pinned) line += ' [Pinned]';
          if (m.is_resolved) line += ' [Resolved]';
          return line;
        }).join('\n');
        memoryIds = memories.map(m => m.id);
      }
    } catch (e) {
      fastify.log.error('Memory retrieval failed:', e.message);
    }
  }

  if (memoryContext) {
    systemContent += '\n\n## 现有记忆\n\n' + memoryContext;
    const nowISO = new Date().toISOString();
    memoryIds.forEach(id => {
      safeFetch(`${process.env.SUPABASE_URL}/rest/v1/memories?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'apikey': process.env.SUPABASE_KEY,
          'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
        },
        body: JSON.stringify({ last_accessed_at: nowISO }),
      }).catch(e => fastify.log.error(e));
    });
  }

  // 3. 检索上下文
  let recentContext = [];
  try {
    const ctxResponse = await safeFetch(
      `${process.env.SUPABASE_URL}/rest/v1/conversations?select=role,content&order=created_at.desc&limit=20`,
      { headers: { apikey: process.env.SUPABASE_KEY, Authorization: `Bearer ${process.env.SUPABASE_KEY}` } }
    );
    const ctxData = await ctxResponse.json();
    if (Array.isArray(ctxData)) recentContext = ctxData.reverse();
  } catch (e) {
    fastify.log.error('Context retrieval failed:', e.message);
  }

  // 4. 存储用户消息
  const userMessages = messages.filter(m => m.role === 'user');
  if (userMessages.length > 0) {
    saveContext(userMessages, process.env).catch(e => fastify.log.error(e));
  }

  // 5. 构建 enhancedMessages
  const enhancedMessages = [
    { role: 'system', content: systemContent },
    ...recentContext,
    ...messages.filter(m => m.role !== 'system'),
  ];

  // 6. 调用 LLM
  const llmPayload = {
    model: 'Pro/zai-org/GLM-5.1',
    messages: enhancedMessages,
    stream,
    max_tokens: 8192, // 先保守一点，后面可调大
  };

  try {
    const llmResponse = await safeFetch(
      'https://api.siliconflow.cn/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SILICON_API_KEY}`,
        },
        body: JSON.stringify(llmPayload),
      },
      600000 // 10分钟超时，GLM 大回复也够
    );

    if (stream) {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const reader = llmResponse.body.getReader();
      let buffer = '';
      let fullContent = '';
      let lastChunkTime = Date.now();
      const STREAM_TIMEOUT = 15000;

      const pump = async () => {
        while (true) {
          if (Date.now() - lastChunkTime > STREAM_TIMEOUT) {
            reply.raw.end();
            break;
          }
          const readPromise = reader.read();
          const timeoutPromise = new Promise(resolve =>
            setTimeout(() => resolve({ done: true, value: undefined, timeout: true }), 5000)
          );
          const { done, value, timeout } = await Promise.race([readPromise, timeoutPromise]);
          if (timeout || done) {
            reply.raw.end();
            break;
          }
          lastChunkTime = Date.now();
          buffer += new TextDecoder().decode(value);
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') {
              reply.raw.write('data: [DONE]\n\n');
              reply.raw.end();
              saveContext([{ role: 'assistant', content: fullContent }], process.env).catch(() => {});
              saveMemories(fullContent, process.env).catch(() => {});
              return;
            }
            try {
              const data = JSON.parse(dataStr);
              const delta = data.choices?.[0]?.delta;
              if (delta?.content) fullContent += delta.content;
              reply.raw.write(`${line}\n\n`);
            } catch (parseError) {
              // 忽略解析错误
            }
          }
        }
        if (fullContent) {
          saveContext([{ role: 'assistant', content: fullContent }], process.env).catch(() => {});
          saveMemories(fullContent, process.env).catch(() => {});
        }
      };

      pump();
      return reply;
    } else {
      const data = await llmResponse.json();
      const content = data.choices?.[0]?.message?.content || '';
      if (content) {
        saveContext([{ role: 'assistant', content }], process.env).catch(() => {});
        saveMemories(content, process.env).catch(() => {});
      }
      return reply.send(data);
    }
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send({ error: err.message });
  }
});

// 启动服务
const start = async () => {
  try {// 临时测试路由：验证记忆写入是否正常
fastify.get('/test-write', async (request, reply) => {
  const testContent = `<memory>\n- [2024-05-20][V:0.9][A:0.8][I:7][D:测试] 这是一条强制写入测试，请忽略\n</memory>`;
  await saveMemories(testContent, process.env);
  reply.send({ status: 'ok', message: 'Memory write test triggered. Check Supabase.' });
});
    await fastify.listen({ port: 3000, host: '0.0.0.0' });
    fastify.log.info('AI Memory Service running on port 3000');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
