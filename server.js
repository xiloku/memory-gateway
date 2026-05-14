import Fastify from 'fastify';
import * as cheerio from 'cheerio';

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
    // 博查API的真实返回路径：data.webPages.value
    const webPages = data.webPages || (data.data && data.data.webPages) || {};
    const results = webPages.value || [];

    return reply.send({
      query,
      results: results.map(r => ({
        title: r.name,
        url: r.url,
        snippet: r.snippet || r.summary || ''
      })),
      count: results.length,
      summary: results.length > 0
        ? results.map(r => `- ${r.name}: ${r.snippet || r.summary || ''}`).join('\n')
        : '未找到相关结果。'
    });
  } catch (err) {
    fastify.log.error('搜索失败:', err.message);
    return reply.status(500).send({ error: '搜索失败: ' + err.message });
  }
});

// 健康检查
fastify.get('/health', async () => ({ status: 'ok', service: 'search-service' }));

// 网页抓取路由：提取网页文本和图片，图片调用视觉识别
fastify.post('/fetch', async (request, reply) => {
  const { url } = request.body;
  if (!url || typeof url !== 'string') {
    return reply.status(400).send({ error: '缺少URL参数' });
  }

  try {
    // 抓取网页HTML
    const htmlRes = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AynBot/1.0)' }
    });
    if (!htmlRes.ok) {
      return reply.status(502).send({ error: `网页返回状态码 ${htmlRes.status}` });
    }
    const html = await htmlRes.text();

    // 用 cheerio 解析 HTML
    const $ = cheerio.load(html);

    // 移除噪音元素：脚本、样式、导航、侧边栏、评论区、推荐阅读、广告
    $('script, style, nav, footer, header, aside, .sidebar, .comment, .recommend, .ad, .related, iframe, noscript').remove();

    // 提取正文文本
    const body = $('body').text();
    const cleanText = body
      .replace(/&nbsp;/g, ' ')
      .replace(/\s{2,}/g, '\n')
      .trim()
      .slice(0, 8000);

    // 提取图片URL并转换为绝对路径
    const imgUrls = [];
    $('img').each((_, el) => {
      let src = $(el).attr('src');
      if (src) {
        if (src.startsWith('http')) imgUrls.push(src);
        else if (src.startsWith('//')) imgUrls.push('https:' + src);
        else {
          // 相对路径，拼接完整URL
          const baseUrl = new URL(url);
          src = src.startsWith('/') ? src : '/' + src;
          imgUrls.push(`${baseUrl.protocol}//${baseUrl.host}${src}`);
        }
      }
    });

    // 对前3张图片调用视觉识别
    const visionDescriptions = [];
    for (const imgUrl of imgUrls.slice(0, 3)) {
      try {
        const visionRes = await fetch(`${process.env.VISION_API_URL}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image_url: imgUrl })
        });
        if (visionRes.ok) {
          const visionData = await visionRes.json();
          if (visionData.description) {
            visionDescriptions.push(`[图片描述] ${visionData.description}`);
          }
        }
      } catch (e) {
        // 图片识别失败就跳过
      }
    }

    return reply.send({
      url,
      text: cleanText.slice(0, 4000),
      images: visionDescriptions
    });
  } catch (err) {
    fastify.log.error('Fetch失败:', err.message);
    return reply.status(500).send({ error: '抓取失败: ' + err.message });
  }
});

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
