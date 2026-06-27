console.log("[1] Starting server.js");
try {
    const express = require('express');
    console.log("[2] express imported");

    const path = require('path');
    console.log("[3] path imported");

    const http = require('http');
    console.log("[4] http imported");

    const app = express();
    console.log("[5] express app created");

    const server = http.createServer(app);
    console.log("[6] http server created");

    const PORT = process.env.PORT || 3003;
    console.log("[7] PORT set to:", PORT);

    app.get('/health', (req, res) => {
        console.log("[HEALTH] Got request to /health");
        res.status(200).json({ status: 'ok', message: 'Server is healthy' });
    });

    app.get('/', (req, res) => {
        console.log("[ROOT] Got request to /");
        res.send('Hello Railway from WhatsApp Bulk Sender! 🚀');
    });

    server.listen(PORT, '0.0.0.0', () => {
        console.log(`[9] 🚀 SERVER IS RUNNING! http://0.0.0.0:${PORT}`);
    });

    console.log("[10] End of server.js reached");
} catch (err) {
    console.error("[ERROR] Caught error:", err.message);
    console.error("[ERROR] Stack:", err.stack);
    process.exit(1);
}
