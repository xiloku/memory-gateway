const express = require('express');
const cors = require('cors');
require('dotenv').config();

const memoryRouter = require('./routes/memory');
const chatRouter = require('./routes/chat');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api/memory', memoryRouter);
app.use('/api/chat', chatRouter);

app.listen(PORT, () => {
  console.log(`Memory Gateway running on port ${PORT}`);
});
