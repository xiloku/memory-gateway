import Fastify from 'fastify';

const fastify = Fastify({ logger: true });

// ================== 工具函数 ==================
const safeFetch = async (url, options = {}, timeout = 15000) => {
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
// ================== 搜索路由（博查 Web Search） ==================
fastify.post('/search', async (request, reply) => {
  const { query } = request.body;

  if (!query || typeof query !== 'string') {
    return reply.status(400).send({ error: '缺少搜索关键词' });
  }

  try {
    const searchRes = await safeFetch(
      'https://api.bochaai.com/v1/web-search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.BOCHA_API_KEY}`
        },
        body: JSON.stringify({
          query: query,
          count: 5
        })
      },
      10000
    );

    const data = await searchRes.json();
    const results = data.results || [];

    return reply.send({
      query,
      results: results.map(r => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet || r.summary || ''
      })),
      count: results.length,
      summary: results.length > 0
        ? results.map(r => `- ${r.title}: ${r.snippet || r.summary || ''}`).join('\n')
        : '未找到相关结果。'
    });
  } catch (err) {
    fastify.log.error('搜索失败:', err.message);
    return reply.status(500).send({ error: '搜索失败: ' + err.message });
  }
});

// 健康检查
fastify.get('/health', async () => ({ status: 'ok', service: 'search-service' }));

// 启动服务
const start = async () => {
  try {
    await fastify.listen({ port: 3001, host: '0.0.0.0' });
    fastify.log.info('搜索微服务运行在端口 3001');
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
start();
