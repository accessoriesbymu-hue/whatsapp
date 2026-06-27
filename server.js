const express = require('express');
const path = require('path');
const http = require('http');
const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3003;

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
  console.log('🚀 Server running on port', PORT);
});
