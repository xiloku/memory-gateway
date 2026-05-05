const express = require('express');
const cors = require('cors');
require('dotenv').config();

const memoryRouter = require('./routes/memory');
const chatRouter = require('./routes/chat');

const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/memory', memoryRouter);
app.use('/api/chat', chatRouter);

// 导出给Vercel
module.exports = app;

// 本地开发时启动
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Memory Gateway running on port ${PORT}`);
  });
}
