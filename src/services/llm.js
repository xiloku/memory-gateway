const axios = require('axios');
require('dotenv').config();

async function analyzeEmotion(text) {
  const response = await axios.post(
    `${process.env.SILICON_BASE_URL}/chat/completions`,
    {
      model: 'Qwen/Qwen2.5-7B-Instruct',
      messages: [
        {
          role: 'system',
          content: '分析文本的情感，返回JSON格式：{"valence": 0-1正向, "arousal": 0-1激动度, "domain": "领域标签", "importance": 1-10重要性}'
        },
        {
          role: 'user',
          content: text
        }
      ],
      temperature: 0.3
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.SILICON_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  try {
    return JSON.parse(response.data.choices[0].message.content);
  } catch {
    return { valence: 0.5, arousal: 0.3, domain: 'general', importance: 5 };
  }
}

async function summarize(text) {
  const response = await axios.post(
    `${process.env.SILICON_BASE_URL}/chat/completions`,
    {
      model: 'Qwen/Qwen2.5-7B-Instruct',
      messages: [
        {
          role: 'system',
          content: '用一句话总结这段内容，保留关键信息。'
        },
        {
          role: 'user',
          content: text
        }
      ],
      temperature: 0.3
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.SILICON_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  return response.data.choices[0].message.content;
}

module.exports = { analyzeEmotion, summarize };
