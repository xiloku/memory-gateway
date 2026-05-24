
// server.js
import Fastify from 'fastify';
import SYSTEM_PROMPT from './src/config/prompt.js';  // 这一行是修改重点

// 加载系统提示词（prompt.js）

const fastify = Fastify({ 
  logger: true,
  bodyLimit: 52428800 // 50MB (50 * 1024 * 1024)
});

// ================== 工具函数 ==================
// 获取与上一条用户消息的时间间隔提示
async function getTimeAwarenessHint(env) {
  try {
    const ctxResponse = await safeFetch(
      `${env.SUPABASE_URL}/rest/v1/conversations?select=role,created_at&order=created_at.desc&limit=50`,
      { headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` } }
    );
    const ctxData = await ctxResponse.json();
    const userMessages = ctxData.filter(m => m.role === 'user');
    
    if (userMessages.length >= 2) {
      const lastMsgTime = new Date(userMessages[0].created_at);
      const prevMsgTime = new Date(userMessages[1].created_at);
      const diffMinutes = Math.round((lastMsgTime - prevMsgTime) / 60000);
      
      if (diffMinutes > 60) {
        const now = new Date();
        const timeStr = `${now.getHours()}点${now.getMinutes()}分`;
        return `[系统提示：距离遥上一条消息已经过去了${Math.round(diffMinutes / 60)}小时，现在是${timeStr}。她可能刚忙完，或者又在熬夜。请根据时间变化自然地关心她。]`;
      }
    }
    return '';
  } catch (e) {
    return '';
  }
}
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
// 防爆门：单条上下文最大 5000 字符，超出部分截断
      const safeContent = msg.content.length > 5000 
        ? msg.content.substring(0, 5000) + '...（内容过长已截断）' 
        : msg.content;

      await safeFetch(`${env.SUPABASE_URL}/rest/v1/conversations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': env.SUPABASE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_KEY}`,
        },
        body: JSON.stringify({ role: msg.role, content: safeContent }),
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

async function saveMemories(content, env, memoryIds) {
  console.log('=== saveMemories called ===');
  console.log('DEBUG: content length =', content.length);
  console.log('DEBUG: content last 800 chars:', JSON.stringify(content.slice(-800)));

  function formatTags(rawTags) {
    if (!rawTags || typeof rawTags !== 'string') return null;
    if (rawTags.startsWith('{') && rawTags.endsWith('}')) return rawTags;
    const items = rawTags.split(',').map(t => t.trim()).filter(t => t);
    return '{' + items.map(t => '"' + t.replace(/"/g, '\\"') + '"').join(',') + '}';
  }

  const blockStart = '<memory>';
  const blockEnd = '</memory>';
  const startIdx = content.indexOf(blockStart);
  console.log('DEBUG: startIdx =', startIdx);
  if (startIdx === -1) {
    console.log('DEBUG: <memory> not found, exiting');
    return;
  }

  const endIdx = content.indexOf(blockEnd, startIdx);
  console.log('DEBUG: endIdx =', endIdx);
  if (endIdx === -1) {
    console.log('DEBUG: </memory> not found, exiting');
    return;
  }

  const block = content.substring(startIdx + blockStart.length, endIdx).trim();
  console.log('DEBUG: memory block content:', JSON.stringify(block));
  if (!block) {
    console.log('DEBUG: memory block is empty, exiting');
    return;
  }

  const lines = block.split('\n').map(l => l.trim()).filter(l => l);
  console.log('DEBUG: number of lines in block:', lines.length);
  console.log('DEBUG: lines:', JSON.stringify(lines));

  let processed = 0;
  const MAX_MEMORIES_PER_REQUEST = 5;

  for (const line of lines) {
    console.log('DEBUG: processing line:', JSON.stringify(line));
    if (processed >= MAX_MEMORIES_PER_REQUEST) {
      console.log('DEBUG: max memories per request reached, stopping');
      break;
    }
    if (line.startsWith('//')) {
      console.log('DEBUG: skipping comment line');
      continue;
    }

    // 统一处理项目符号
    let normalizedLine = line.replace(/^•\s*/, '- ').replace(/^\*\s*/, '- ');
    console.log('DEBUG: normalized line:', JSON.stringify(normalizedLine));

    if (!normalizedLine.startsWith('-') && !normalizedLine.startsWith('•') && !normalizedLine.startsWith('*')) {
      console.log('DEBUG: line does not start with - or • or *, skipping');
      continue;
    }

    const lineContent = normalizedLine.replace(/^[-•*]\s*/, '');
    console.log('DEBUG: lineContent:', JSON.stringify(lineContent));

    try {
      // --- UPDATE ---
      const updateMatch = lineContent.match(/\[UPDATE:(\d+)\](.+)/);
      if (updateMatch) {
        console.log('DEBUG: matched UPDATE, id =', updateMatch[1]);
        const seq = parseInt(updateMatch[1]);
        const id = memoryIds[seq - 1];  // 将序号转为真实 UUID
        if (!id) {
          console.log('DEBUG: invalid sequence number for UPDATE:', seq);
          continue;
        }
        const newContent = updateMatch[2].trim();
        const embedding = await getEmbedding(newContent, env.SILICON_API_KEY);
        const updateData = { content: newContent, embedding, updated_at: new Date().toISOString() };

        const valenceMatch = lineContent.match(/\[V:([\d.]+)\]/);
        if (valenceMatch) updateData.valence = parseFloat(valenceMatch[1]);
        const arousalMatch = lineContent.match(/\[A:([\d.]+)\]/);
        if (arousalMatch) updateData.arousal = parseFloat(arousalMatch[1]);
        const importanceMatch = lineContent.match(/\[I:(\d+)\]/);
        if (importanceMatch) updateData.importance = parseInt(importanceMatch[1]);
        const domainMatch = lineContent.match(/\[D:([^\]]+)\]/);
        if (domainMatch) updateData.domain = domainMatch[1];
        const tagsMatch = lineContent.match(/\[T:([^\]]+)\]/);
        if (tagsMatch) updateData.tags = formatTags(tagsMatch[1]);
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
        console.log('DEBUG: UPDATE successful for id', id);
        processed++;
        continue;
      }

      // --- DELETE ---
      const deleteMatch = lineContent.match(/\[DELETE:(\d+)\]/);
      if (deleteMatch) {
        console.log('DEBUG: matched DELETE, id =', deleteMatch[1]);
        const seq = parseInt(deleteMatch[1]);
        const id = memoryIds[seq - 1];
        if (!id) {
          console.log('DEBUG: invalid sequence number for DELETE:', seq);
          continue;
        }
        await safeFetch(`${env.SUPABASE_URL}/rest/v1/memories?id=eq.${id}`, {
          method: 'DELETE',
          headers: {
            'apikey': env.SUPABASE_KEY,
            'Authorization': `Bearer ${env.SUPABASE_KEY}`,
          },
        });
        console.log('DEBUG: DELETE successful for id', id);
        processed++;
        continue;
      }

      // --- ADD (完整新格式) ---
      const addMatch = lineContent.match(/\[(\d{4}-\d{2}-\d{2})\]\[V:([\d.]+)\]\[A:([\d.]+)\]\[I:(\d+)\](?:\[D:([^\]]+)\])?(?:\[T:([^\]]+)\])?(?:\[F:(true|false)\])?(?:\[P:(true|false)\])?(?:\[R:(true|false)\])?(?:\[DG:(true|false)\])?(?:\[S:([^\]]+)\])?(.+)/);
      if (addMatch) {
        console.log('DEBUG: matched ADD (full format)');
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
            tags: formatTags(tags),
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
        console.log('DEBUG: ADD successful');
        processed++;
        continue;
      }

      // --- 兼容旧格式 ---
      const oldAddMatch = lineContent.match(/\[(\d{4}-\d{2}-\d{2})\](.+)/);
      if (oldAddMatch) {
        console.log('DEBUG: matched ADD (old format)');
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
        console.log('DEBUG: ADD (old format) successful');
        processed++;
        continue;
      }

      console.log('DEBUG: line did not match any pattern:', JSON.stringify(lineContent));
    } catch (innerError) {
      console.error('Save memory entry error:', innerError.message);
      console.error('DEBUG: error stack:', innerError.stack);
    }
  }
  console.log('DEBUG: saveMemories finished, processed =', processed);
}

// 状态同步路由：接收来自遥的本地脚本的状态更新
fastify.post('/v1/status', async (request, reply) => {
  const { status, timestamp } = request.body;

  if (!status) {
    return reply.status(400).send({ error: '缺少 status 参数' });
  }

  try {
    // 将状态作为一条特殊的系统消息存入对话上下文
    const statusMessage = `[遥的状态：${status}]`;

    await safeFetch(`${process.env.SUPABASE_URL}/rest/v1/conversations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
      },
      body: JSON.stringify({
        role: 'system',
        content: statusMessage,
      }),
    });

    fastify.log.info(`Status synced: ${status}`);
    return reply.send({ success: true, status: statusMessage });
  } catch (err) {
    fastify.log.error('Status sync failed:', err.message);
    return reply.status(500).send({ error: '状态同步失败' });
  }
});

// ================== 主路由 ==================
fastify.post('/v1/chat/completions', async (request, reply) => {
  const { messages, stream = false } = request.body;

  // 联网搜索拦截：检测所有消息中的 <search> 标签并调用搜索微服务
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.content?.includes('<search>')) {
      const searchMatch = msg.content.match(/<search>(.*?)<\/search>/);
      if (searchMatch) {
        const query = searchMatch[1].trim();
        try {
          const searchRes = await fetch('http://search-service:3001/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
          });
          const searchData = await searchRes.json();
          const summary = searchData.summary || '未找到相关结果。';
          
          messages[i] = {
            ...msg,
            content: `[系统提示：以下是关于"${query}"的搜索结果]\n${summary}\n\n[请根据以上搜索结果回答用户的问题]`
          };
        } catch (err) {
          fastify.log.error('搜索微服务调用失败:', err);
        }
        break; // 只处理第一个包含 <search> 的消息
      }
    }
  }

  // 网页抓取拦截：检测所有消息中的 <fetch> 标签并调用搜索微服务的 /fetch
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.content?.includes('<fetch>')) {
      const fetchMatch = msg.content.match(/<fetch>(.*?)<\/fetch>/);
      if (fetchMatch) {
        const fetchUrl = fetchMatch[1].trim();
        try {
          const fetchRes = await fetch('http://search-service:3001/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: fetchUrl })
          });
          const fetchData = await fetchRes.json();
          const fetchedInfo = `网页主要内容：${fetchData.text || '(无文本)'}\n图片描述：${(fetchData.images || []).join('；')}`;
          
          messages[i] = {
            ...msg,
            content: `[系统提示：以下是网页 ${fetchUrl} 的内容]\n${fetchedInfo}\n\n[请根据以上内容回答用户的问题]`
          };
        } catch (err) {
          fastify.log.error('网页抓取失败:', err);
        }
        break; // 只处理第一个包含 <fetch> 的消息
      }
    }
  }

  // 1. 系统提示
  const now = new Date();
  const timeStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  let systemContent = SYSTEM_PROMPT + `\n[当前时间: ${timeStr}]`;

  // 时间感知：自动检测与上一条消息的时间间隔
  const timeHint = await getTimeAwarenessHint(process.env);
  if (timeHint) {
    systemContent += '\n' + timeHint;
  }

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
        memoryContext = memories.map((m, idx) => {
          let line = `${idx + 1}.[${m.date}]${m.content}`;
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

  // 5. 视觉拦截：将图片转为文字描述，再构建增强消息
  const processedMessages = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      processedMessages.push(msg);
      continue;
    }
    if (Array.isArray(msg.content)) {
      const newContent = [];
      for (const part of msg.content) {
        if (part.type === 'image_url' && part.image_url?.url?.startsWith('data:image')) {
          const base64Data = part.image_url.url.split(';base64,')[1] || part.image_url.url.split(',')[1];
          try {
            const visionRes = await safeFetch(
              'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${process.env.TENCENT_VISION_API_KEY}`,
                },
                body: JSON.stringify({
                  model: 'hunyuan-vision',
                  messages: [{
                    role: 'user',
                    content: [
                      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } },
                      { type: 'text', text: '请客观描述图片内容，不要添加评价或臆测。' }
                    ]
                  }]
                }),
              },
              30000
            );
            const visionData = await visionRes.json();
            const description = visionData.choices?.[0]?.message?.content || '无法识别这张图片。';
            newContent.push({ type: 'text', text: `[用户发来了一张图片，内容描述：${description}]` });
          } catch (err) {
            fastify.log.error('Vision intercept error:', err.message);
            newContent.push({ type: 'text', text: '[用户发来了一张图片，但暂时无法识别。]' });
          }
        } else {
          newContent.push(part);
        }
      }
      processedMessages.push({ ...msg, content: newContent });
    } else {
      processedMessages.push(msg);
    }
  }

  // 5.1 构建 enhancedMessages（使用处理后的消息）
  const enhancedMessages = [
    { role: 'system', content: systemContent },
    ...recentContext,
    ...processedMessages.filter(m => m.role !== 'system'),
  ];

  // 视觉友好遗忘：将图片描述视为普通对话碎片，依赖上下文窗口自然淘汰
  const cleanedMessages = [];
  const MAX_CONTEXT_MESSAGES = 40; // user + assistant 总条数，约等于20轮对话

  // 只保留系统消息 + 最近的消息，旧对话（含图片描述）会自动移出窗口
  if (enhancedMessages.length > MAX_CONTEXT_MESSAGES) {
    const systemMessages = enhancedMessages.filter(m => m.role === 'system');
    const recentMessages = enhancedMessages.slice(-MAX_CONTEXT_MESSAGES);
    cleanedMessages.push(...systemMessages, ...recentMessages);
  } else {
    cleanedMessages.push(...enhancedMessages);
  }

  // 发送前瘦身：截断所有超过 3000 字符的单条消息，防止 Token 爆炸
  for (const msg of enhancedMessages) {
    if (typeof msg.content === 'string' && msg.content.length > 3000) {
      msg.content = msg.content.substring(0, 3000) + '...（内容过长已截断）';
    }
  }

  // 6. 调用 LLM 模型路由：根据模型名自动切换 API 地址
  const modelName = body.model || 'Pro/zai-org/GLM-5.1';

  const llmPayload = {
    model: modelName,
    messages: cleanedMessages,
    stream,
    max_tokens: 8192,
  };

  let llmApiUrl = 'https://api.siliconflow.cn/v1/chat/completions';
  let llmApiKey = process.env.SILICON_API_KEY;

  // 如果模型名以 "venice:" 开头，走 OpenRouter 代理
  if (modelName.startsWith('venice:')) {
    llmApiUrl = 'http://localhost:8081/v1/chat/completions'; // 本机 Nginx 代理
    llmApiKey = process.env.OPENROUTER_API_KEY;
    llmPayload.model = modelName.replace('venice:', ''); // 去掉前缀，发送真实模型名给 OpenRouter
  }

  try {
    const llmResponse = await safeFetch(
      llmApiUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${llmApiKey}`,
        },
        body: JSON.stringify(llmPayload),
      },
      600000
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
          saveMemories(fullContent, process.env, memoryIds).catch(() => {});
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
          saveMemories(fullContent, process.env, memoryIds).catch(() => {});
        }
      };

      pump();
      return reply;
    } else {
      const data = await llmResponse.json();
      const content = data.choices?.[0]?.message?.content || '';
      if (content) {
        saveContext([{ role: 'assistant', content }], process.env).catch(() => {});
        saveMemories(content, process.env, memoryIds).catch(() => {});
      }
      return reply.send(data);
    }
  } catch (err) {
    fastify.log.error(err);
    return reply.status(500).send({ error: err.message });
  }
});

// 视觉识别路由：将图片转为文字描述
fastify.post('/v1/vision', async (request, reply) => {
  const { image_base64 } = request.body;
  
  if (!image_base64) {
    return reply.status(400).send({ error: '缺少 image_base64 参数' });
  }

  try {
    const visionResponse = await safeFetch(
      'https://api.hunyuan.cloud.tencent.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.TENCENT_VISION_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'hunyuan-vision',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/jpeg;base64,${image_base64}`
                  }
                },
                {
                  type: 'text',
                  text: '请用中文描述这张图片的内容，尽量详细但不要添加任何评价或臆测。'
                }
              ]
            }
          ]
        }),
      },
      30000
    );

    const data = await visionResponse.json();
    const description = data.choices?.[0]?.message?.content || '无法识别图片内容';
    
    return reply.send({ description });
  } catch (err) {
    fastify.log.error('Vision API error:', err.message);
    return reply.status(500).send({ error: '图片识别失败: ' + err.message });
  }
});

// 启动服务
const start = async () => {
  try {// 临时测试路由：验证记忆写入是否正常
fastify.get('/test-write', async (request, reply) => {
  const testContent = `<memory>\n- [2024-05-20][V:0.9][A:0.8][I:7][D:测试] 这是一条强制写入测试，请忽略\n</memory>`;
  await saveMemories(testContent, process.env,[]);
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
