const axios = require('axios');
require('dotenv').config();

async function getEmbedding(text) {
  const response = await axios.post(
    `${process.env.SILICON_BASE_URL}/embeddings`,
    {
      model: 'BAAI/bge-large-zh-v1.5',
      input: text
    },
    {
      headers: {
        'Authorization': `Bearer ${process.env.SILICON_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  return response.data.data[0].embedding;
}

module.exports = { getEmbedding };
