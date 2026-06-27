require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const session = require('express-session');
const { MongoStore } = require('connect-mongo');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

// ─── MongoDB Connection & Fallback Setup ──────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI;
const LOCAL_USERS_FILE = path.join(__dirname, 'users_local.json');
const LOCAL_LOGS_FILE = path.join(__dirname, 'logs_local.json');
const USERS_FILE = path.join(__dirname, 'users.json');

function readLocalFile(filePath, defaultVal = []) {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (err) {
        console.error(`Error reading ${filePath}:`, err.message);
    }
    return defaultVal;
}

function writeLocalFile(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error(`Error writing to ${filePath}:`, err.message);
    }
}

class MockQuery {
    constructor(data) {
        this.data = data;
    }
    sort(sortObj) {
        if (!sortObj) return this;
        const key = Object.keys(sortObj)[0];
        const dir = sortObj[key];
        this.data.sort((a, b) => {
            const valA = a[key];
            const valB = b[key];
            if (valA < valB) return dir === -1 ? 1 : -1;
            if (valA > valB) return dir === -1 ? -1 : 1;
            return 0;
        });
        return this;
    }
    skip(n) {
        this.data = this.data.slice(n);
        return this;
    }
    limit(n) {
        this.data = this.data.slice(0, n);
        return this;
    }
    async lean() {
        return this.data;
    }
    then(onResolve, onReject) {
        return this.lean().then(onResolve, onReject);
    }
}

// ─── Mongoose Models (re-assignable let variables) ──────────────────────────
const userSchema = new mongoose.Schema({
    username:    { type: String, required: true, unique: true, lowercase: true, trim: true },
    displayName: { type: String, required: true },
    password:    { type: String, required: true },
    createdAt:   { type: Date, default: Date.now }
});
let User = mongoose.model('User', userSchema);

const sendLogSchema = new mongoose.Schema({
    username:     { type: String, required: true, index: true },
    recipientPhone: { type: String },
    recipientName:  { type: String },
    status:       { type: String, enum: ['success', 'failed'], required: true },
    errorMessage: { type: String, default: null },
    variantIndex: { type: Number, default: 0 },
    sentAt:       { type: Date, default: Date.now }
});
let SendLog = mongoose.model('SendLog', sendLogSchema);

// ─── Migrate existing users.json (Mongoose) ──────────────────────────────────
async function migrateUsersJson() {
    if (!fs.existsSync(USERS_FILE)) return;
    try {
        const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        const keys = Object.keys(data);
        if (keys.length === 0) return;

        let migrated = 0;
        for (const key of keys) {
            const u = data[key];
            const exists = await User.findOne({ username: key });
            if (!exists) {
                await User.create({
                    username:    key,
                    displayName: u.displayName || key,
                    password:    u.password,
                    createdAt:   u.createdAt ? new Date(u.createdAt) : new Date()
                });
                migrated++;
            }
        }

        if (migrated > 0) {
            console.log(`✅ Migrated ${migrated} user(s) from users.json to MongoDB`);
        }

        fs.renameSync(USERS_FILE, USERS_FILE + '.bak');
        console.log('📁 users.json renamed to users.json.bak');
    } catch (err) {
        console.error('⚠️  Migration error:', err.message);
    }
}

// ─── Migrate existing users.json (Local File DB fallback) ────────────────────
async function migrateUsersJsonLocal() {
    if (!fs.existsSync(USERS_FILE)) return;
    try {
        const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        const keys = Object.keys(data);
        if (keys.length === 0) return;

        const localUsers = readLocalFile(LOCAL_USERS_FILE);
        let migrated = 0;
        for (const key of keys) {
            const u = data[key];
            const exists = localUsers.some(user => user.username === key);
            if (!exists) {
                localUsers.push({
                    username:    key,
                    displayName: u.displayName || key,
                    password:    u.password,
                    createdAt:   u.createdAt ? new Date(u.createdAt) : new Date()
                });
                migrated++;
            }
        }

        if (migrated > 0) {
            writeLocalFile(LOCAL_USERS_FILE, localUsers);
            console.log(`✅ Migrated ${migrated} user(s) from users.json to local JSON DB`);
        }

        fs.renameSync(USERS_FILE, USERS_FILE + '.bak');
        console.log('📁 users.json renamed to users.json.bak');
    } catch (err) {
        console.error('⚠️  Migration error:', err.message);
    }
}

// ─── Helper: delete directory recursively ────────────────────────────────────
function deleteDirectory(dirPath) {
    if (fs.existsSync(dirPath)) {
        fs.readdirSync(dirPath).forEach((file) => {
            const curPath = path.join(dirPath, file);
            try {
                if (fs.lstatSync(curPath).isDirectory()) {
                    deleteDirectory(curPath);
                } else {
                    fs.unlinkSync(curPath);
                }
            } catch (err) {
                console.warn(`Warning: Could not delete ${curPath}:`, err.message);
            }
        });
        try {
            fs.rmdirSync(dirPath);
        } catch (err) {
            console.warn(`Warning: Could not remove directory ${dirPath}:`, err.message);
        }
    }
}

// ─── Express + session setup ─────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

let actualSessionMiddleware = null;
const sessionMiddleware = (req, res, next) => {
    if (actualSessionMiddleware) {
        actualSessionMiddleware(req, res, next);
    } else {
        const interval = setInterval(() => {
            if (actualSessionMiddleware) {
                clearInterval(interval);
                actualSessionMiddleware(req, res, next);
            }
        }, 50);
    }
};

// Attempt MongoDB Connection and fall back if fails
console.log('Connecting to MongoDB...');
mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 5000 })
    .then(() => {
        console.log('✅ MongoDB connected successfully');
        migrateUsersJson();

        actualSessionMiddleware = session({
            secret: process.env.SESSION_SECRET || 'wa-bulk-sender-secret-2024-xK9pL',
            resave: false,
            saveUninitialized: false,
            store: MongoStore.create({
                mongoUrl: MONGO_URI,
                collectionName: 'sessions',
                ttl: 7 * 24 * 60 * 60
            }),
            cookie: {
                maxAge: 7 * 24 * 60 * 60 * 1000,
                httpOnly: true
            }
        });

        // Run auto-init since DB is ready
        runAutoInit();
    })
    .catch(async (err) => {
        console.warn('❌ MongoDB connection error:', err.message);
        console.warn('⚠️  Could not connect to MongoDB Atlas. Falling back to local file-based database.');

        // Override models with file-based mock databases
        User = {
            async findOne({ username }) {
                const users = readLocalFile(LOCAL_USERS_FILE);
                return users.find(u => u.username === username) || null;
            },
            async create(userData) {
                const users = readLocalFile(LOCAL_USERS_FILE);
                const newUser = {
                    createdAt: new Date(),
                    ...userData
                };
                users.push(newUser);
                writeLocalFile(LOCAL_USERS_FILE, users);
                return newUser;
            },
            find(query, projection) {
                return {
                    lean: async () => {
                        const users = readLocalFile(LOCAL_USERS_FILE);
                        return users.map(u => ({ username: u.username }));
                    }
                };
            }
        };

        SendLog = {
            find(filter) {
                const logs = readLocalFile(LOCAL_LOGS_FILE);
                const filtered = logs.filter(l => l.username === filter.username);
                return new MockQuery(filtered);
            },
            async countDocuments(filter) {
                const logs = readLocalFile(LOCAL_LOGS_FILE);
                return logs.filter(l => l.username === filter.username).length;
            },
            async create(logData) {
                const logs = readLocalFile(LOCAL_LOGS_FILE);
                const newLog = {
                    sentAt: new Date(),
                    ...logData
                };
                logs.push(newLog);
                writeLocalFile(LOCAL_LOGS_FILE, logs);
                return newLog;
            },
            async deleteMany(filter) {
                const logs = readLocalFile(LOCAL_LOGS_FILE);
                const kept = logs.filter(l => l.username !== filter.username);
                writeLocalFile(LOCAL_LOGS_FILE, kept);
                return { deletedCount: logs.length - kept.length };
            }
        };

        await migrateUsersJsonLocal();

        const FileStore = require('session-file-store')(session);
        const fileSessionStore = new FileStore({
            path: path.join(__dirname, 'sessions'),
            ttl: 7 * 24 * 60 * 60
        });

        actualSessionMiddleware = session({
            secret: process.env.SESSION_SECRET || 'wa-bulk-sender-secret-2024-xK9pL',
            resave: false,
            saveUninitialized: false,
            store: fileSessionStore,
            cookie: {
                maxAge: 7 * 24 * 60 * 60 * 1000,
                httpOnly: true
            }
        });

        // Run auto-init since fallback DB is ready
        runAutoInit();
    });

app.use(sessionMiddleware);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Socket.io with session sharing ──────────────────────────────────────────
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    transports: ['websocket', 'polling']
});

// Share express-session with socket.io
io.use((socket, next) => {
    sessionMiddleware(socket.request, socket.request.res || {}, next);
});

// ─── Uploads setup ───────────────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage });
app.use('/uploads', express.static(uploadsDir));

// ─── Per-user WhatsApp client store ──────────────────────────────────────────
// Map<username, { client, isReady, qrCache, isSending, isInitializing, sockets[] }>
const userClients = new Map();

function getUserData(username) {
    if (!userClients.has(username)) {
        userClients.set(username, {
            client: null,
            isReady: false,
            qrCache: null,
            isSending: false,
            isInitializing: false,
            sockets: []
        });
    }
    return userClients.get(username);
}

// Kill leftover Chrome/Chromium processes (Windows-only)
function killLeftoverChromeProcesses() {
  if (process.platform === 'win32') {
    try {
      const { execSync } = require('child_process');
      // Kill all Chrome processes that might be leftover (use with caution!)
      execSync('taskkill /F /IM chrome.exe /T 2>nul', { stdio: 'ignore' });
      console.log('Killed leftover Chrome processes');
    } catch (err) {
      // Ignore errors (no Chrome processes found)
    }
  }
}

// ─── Clean stale Chrome lock files recursively ───────────────────────────────
function cleanChromeLock(username) {
    const clientId = username.replace(/[^a-zA-Z0-9_-]/g, '_');
    const authDir = path.join(__dirname, '.wwebjs_auth', `session-${clientId}`);
    
    // Kill leftover Chrome processes first
    killLeftoverChromeProcesses();

    // Delete top-level singleton locks and browser-active files
    const topLevelFiles = [
        'SingletonLock', 'SingletonCookie', 'SingletonSocket',
        'DevToolsActivePort', 'Last Browser'
    ];
    topLevelFiles.forEach(lf => {
        const lockPath = path.join(authDir, lf);
        try { if (fs.existsSync(lockPath)) { fs.unlinkSync(lockPath); console.log(`[${username}] Removed stale file: ${lf}`); } } catch {}
    });

    // Delete ALL LOCK files recursively in subdirectories
    function deleteLocksRecursive(dir) {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach((file) => {
            const curPath = path.join(dir, file);
            if (fs.lstatSync(curPath).isDirectory()) {
                deleteLocksRecursive(curPath);
            } else if (
                file === 'LOCK' || 
                file.endsWith('.lock') || 
                file === 'DevToolsActivePort'
            ) {
                try { fs.unlinkSync(curPath); console.log(`[${username}] Removed stale lock/file: ${curPath}`); } catch {}
            }
        });
    }
    deleteLocksRecursive(authDir);
}

function emitToUser(username, event, data) {
    const ud = userClients.get(username);
    if (ud) ud.sockets.forEach(s => s.emit(event, data));
}

// ─── Find system Chrome ───────────────────────────────────────────────────────
function findSystemChrome() {
    const paths = [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\Application\\chrome.exe',
    ];
    return paths.find(p => { try { return fs.existsSync(p); } catch { return false; } }) || null;
}

// ─── Create WhatsApp client for a user ───────────────────────────────────────
async function createClient(username) {
    const ud = getUserData(username);
    console.log(`[${username}] Creating WhatsApp client...`);
    cleanChromeLock(username);
    // Wait a second to allow processes to be fully killed and files released
    await wait(1000);
    const chromePath = findSystemChrome();

    const clientId = username.replace(/[^a-zA-Z0-9_-]/g, '_');
    const client = new Client({
        authStrategy: new LocalAuth({ clientId }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', '--disable-gpu',
                '--disable-extensions', '--no-first-run',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--hide-scrollbars', '--mute-audio',
                '--window-size=1280,720',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-site-isolation-trials',
                '--single-process', '--no-zygote'
            ],
            protocolTimeout: 600000,
            timeout: 600000,
            ignoreHTTPSErrors: true,
            defaultViewport: null
        },
        qrTimeoutMs: 600000,
        authTimeoutMs: 600000,
        takeoverOnConflict: false,
        restartOnAuthFail: true
    });

    ud.client = client;

    client.on('loading_screen', (percent, message) => {
        emitToUser(username, 'loading', { percent, message });
    });

    client.on('qr', async (qr) => {
        console.log(`[${username}] QR code generated`);
        const qrUrl = await qrcode.toDataURL(qr);
        ud.qrCache = qrUrl;
        emitToUser(username, 'qr', qrUrl);
    });

    client.on('ready', () => {
        console.log(`[${username}] WhatsApp ready!`);
        ud.isReady = true;
        ud.isInitializing = false;
        ud.qrCache = null;
        emitToUser(username, 'ready', null);
        client.getState().catch(() => {});
    });

    client.on('authenticated', () => {
        console.log(`[${username}] Authenticated`);
        ud.qrCache = null;
        emitToUser(username, 'authenticated', null);
    });

    client.on('auth_failure', (msg) => {
        console.error(`[${username}] Auth failure:`, msg);
        ud.isReady = false;
        ud.isInitializing = false;
        ud.client = null;
        emitToUser(username, 'auth_failure', msg);
    });

    client.on('disconnected', (reason) => {
        console.log(`[${username}] Disconnected:`, reason);
        ud.isReady = false;
        emitToUser(username, 'auth_failure', 'WhatsApp disconnected: ' + reason);
        // Clean up locks after disconnect to prevent EBUSY errors next time
        setTimeout(() => cleanChromeLock(username), 1000);
    });

    client.on('error', (err) => {
        console.error(`[${username}] Client error:`, err);
        emitToUser(username, 'error', 'Client error: ' + (err.message || err));
    });

    return client;
}

// Helper to wait a bit
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Destroy WhatsApp client for a user ──────────────────────────────────────
async function destroyClient(username) {
    const ud = getUserData(username);
    ud.isReady = false;
    ud.qrCache = null;
    if (ud.client) {
        try {
            console.log(`[${username}] Destroying client...`);
            // Try to destroy, but if it throws (like EBUSY), just log and continue
            try {
                await ud.client.destroy();
            } catch (destroyErr) {
                console.error(`[${username}] Error during client destroy (continuing anyway):`, destroyErr.message);
            }
        } finally {
            // Always clear the client reference
            ud.client = null;
        }
    }
}

// ─── Auth middleware for API ──────────────────────────────────────────────────
function requireAuth(req, res, next) {
    if (!req.session.username) return res.status(401).json({ error: 'Not authenticated' });
    next();
}

// ─── Health check route ───────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is running' });
});

// ─── Auth API routes ──────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
    if (req.session.username) {
        res.json({ username: req.session.username });
    } else {
        res.status(401).json({ error: 'Not authenticated' });
    }
});

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
    if (username.trim().length < 3) return res.status(400).json({ error: 'Username must be at least 3 characters' });
    if (!/^[a-zA-Z0-9_-]+$/.test(username.trim())) return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores (_) and hyphens (-). No spaces allowed.' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    try {
        const key = username.trim().toLowerCase();
        const existing = await User.findOne({ username: key });
        if (existing) return res.status(409).json({ error: 'This username is already taken' });

        const hash = await bcrypt.hash(password, 10);
        await User.create({ username: key, displayName: username.trim(), password: hash });

        req.session.username = key;
        req.session.displayName = username.trim();
        res.json({ success: true, username: key });
    } catch (err) {
        console.error('Register error:', err.message);
        res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });

    try {
        const key = username.trim().toLowerCase();
        const user = await User.findOne({ username: key });
        if (!user) return res.status(401).json({ error: 'Invalid username or password' });

        const valid = await bcrypt.compare(password, user.password);
        if (!valid) return res.status(401).json({ error: 'Invalid username or password' });

        req.session.username = key;
        req.session.displayName = user.displayName || key;
        res.json({ success: true, username: key });
    } catch (err) {
        console.error('Login error:', err.message);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

// ─── Check if user has a saved WhatsApp session ───────────────────────────────
app.get('/api/has-session', requireAuth, (req, res) => {
    const username = req.session.username;
    const clientId = username.replace(/[^a-zA-Z0-9_-]/g, '_');
    const authPath = path.join(__dirname, '.wwebjs_auth', `session-${clientId}`);
    const hasSession = fs.existsSync(authPath);
    res.json({ hasSession });
});

// ─── Send History API ─────────────────────────────────────────────────────────
app.get('/api/send-history', requireAuth, async (req, res) => {
    try {
        const username = req.session.username;
        const page = parseInt(req.query.page) || 1;
        const limit = 100;
        const skip = (page - 1) * limit;

        const [logs, total] = await Promise.all([
            SendLog.find({ username })
                .sort({ sentAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            SendLog.countDocuments({ username })
        ]);

        res.json({ logs, total, page, pages: Math.ceil(total / limit) });
    } catch (err) {
        console.error('Send history error:', err.message);
        res.status(500).json({ error: 'Could not fetch history' });
    }
});

// ─── Clear send history ───────────────────────────────────────────────────────
app.delete('/api/send-history', requireAuth, async (req, res) => {
    try {
        const username = req.session.username;
        await SendLog.deleteMany({ username });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Could not clear history' });
    }
});

// ─── File upload routes (auth required) ──────────────────────────────────────
app.post('/upload-media', requireAuth, upload.single('media'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    res.json({
        filename: req.file.filename,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        path: '/uploads/' + req.file.filename
    });
});

app.post('/upload-excel', requireAuth, upload.single('excel'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    try {
        const workbook = XLSX.readFile(req.file.path, { cellNF: true });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const sheetData = XLSX.utils.sheet_to_json(sheet, { header: 1 });

        try { fs.unlinkSync(req.file.path); } catch {}

        if (sheetData.length < 2) return res.status(400).json({ error: 'Excel file must have at least a header row and one data row' });

        const headers = sheetData[0].map(h => String(h).trim());
        const nameIndex = headers.findIndex(h => h.toLowerCase().includes('name'));
        const phoneIndex = headers.findIndex(h =>
            h.toLowerCase().includes('phone') ||
            h.toLowerCase().includes('number') ||
            h.toLowerCase().includes('mobile')
        );

        if (phoneIndex === -1) return res.status(400).json({ error: 'Could not find a phone column. Use "Phone", "Number", or "Mobile".' });

        const contacts = [];
        for (let i = 1; i < sheetData.length; i++) {
            const row = sheetData[i];
            if (!row || row.length === 0) continue;
            let phone = '';
            const cellValue = row[phoneIndex];
            if (cellValue !== undefined && cellValue !== null) {
                const cell = sheet[XLSX.utils.encode_cell({ r: i, c: phoneIndex })];
                phone = (cell && cell.w) ? cell.w : String(cellValue);
                phone = phone.trim().replace(/[^0-9+]/g, '');
            }
            let name = '';
            if (nameIndex !== -1 && row[nameIndex] !== undefined && row[nameIndex] !== null) {
                name = String(row[nameIndex]).trim();
            }
            if (phone) contacts.push({ phone, name });
        }

        res.json({ contacts });
    } catch (error) {
        console.error('Excel upload error:', error);
        res.status(500).json({ error: 'Error reading Excel file: ' + error.message });
    }
});

// ─── Socket.io connection handler ────────────────────────────────────────────
io.on('connection', (socket) => {
    const username = socket.request.session && socket.request.session.username;

    if (!username) {
        console.log('Unauthenticated socket — ignoring');
        socket.emit('auth_required');
        return;
    }

    console.log(`[${username}] Socket connected`);
    const ud = getUserData(username);
    ud.sockets.push(socket);

    // Sync current state to newly connected socket
    setTimeout(() => {
        if (ud.isReady) {
            socket.emit('ready');
        } else if (ud.qrCache) {
            socket.emit('qr', ud.qrCache);
        } else if (ud.client) {
            socket.emit('loading', { percent: 20, message: 'WhatsApp is starting up...' });
        }
    }, 300);

    // ── Initialize WhatsApp ──────────────────────────────────────────────────
    socket.on('initialize-client', async () => {
        console.log(`[${username}] Initialize request`);

        if (ud.isSending) {
            socket.emit('error', 'Please wait for messages to finish sending!');
            return;
        }

        if (ud.isReady) {
            socket.emit('ready');
            return;
        }

        if (ud.isInitializing || (ud.client && !ud.isReady)) {
            if (ud.qrCache) socket.emit('qr', ud.qrCache);
            else socket.emit('loading', { percent: 20, message: 'WhatsApp is starting up, please wait...' });
            return;
        }

        if (!ud.client) {
            ud.isInitializing = true;
            await createClient(username);
            ud.client.initialize().catch(err => {
                console.error(`[${username}] Init error:`, err.message);
                ud.isReady = false;
                ud.isInitializing = false;
                ud.client = null;
                emitToUser(username, 'error', 'Initialization error: ' + (err.message || err));
            });
        }
    });

    // ── Clear WhatsApp session ───────────────────────────────────────────────
    socket.on('clear-session', async () => {
        console.log(`[${username}] Clearing session...`);
        await destroyClient(username);
        const clientId = username.replace(/[^a-zA-Z0-9_-]/g, '_');
        const authPath  = path.join(__dirname, '.wwebjs_auth',  `session-${clientId}`);
        const cachePath = path.join(__dirname, '.wwebjs_cache', `session-${clientId}`);
        try { deleteDirectory(authPath);  } catch {}
        try { deleteDirectory(cachePath); } catch {}
        const ud2 = getUserData(username);
        ud2.client = null;
        ud2.isReady = false;
        ud2.isInitializing = false;
        ud2.qrCache = null;
        emitToUser(username, 'session-cleared', null);
        console.log(`[${username}] Session cleared`);
    });

    // ── Send messages ────────────────────────────────────────────────────────
    socket.on('send-messages', async (data) => {
        const { contacts, message, messageVariants, media, variantMediaList, mediaMode, minInterval = 1, maxInterval = 3 } = data;

        // Build the variants list
        const variants = (Array.isArray(messageVariants) && messageVariants.length > 0)
            ? messageVariants
            : (message ? [message] : []);

        function pickVariantResult() {
            if (variants.length === 0) return { msg: '', idx: 0 };
            const idx = Math.floor(Math.random() * variants.length);
            return { msg: variants[idx], idx };
        }

        function resolveMedia(variantIdx) {
            if (mediaMode === 'different' && Array.isArray(variantMediaList) && variantMediaList[variantIdx]) {
                return variantMediaList[variantIdx];
            }
            return media || null;
        }

        if (!ud.client || !ud.isReady) {
            socket.emit('error', 'WhatsApp not ready. Please re-initialize.');
            return;
        }

        if (ud.isSending) {
            socket.emit('error', 'Already sending messages, please wait!');
            return;
        }

        ud.isSending = true;
        console.log(`[${username}] Starting to send to ${contacts.length} contacts`);

        // Pre-send health check
        try {
            const state = await ud.client.getState();
            if (!state) throw new Error('Client state is null');
        } catch (healthErr) {
            console.error(`[${username}] Pre-send health check failed:`, healthErr.message);
            ud.isReady = false;
            ud.isInitializing = false;
            ud.client = null;
            ud.isSending = false;
            emitToUser(username, 'error', '⚠️ WhatsApp is not ready. Please re-initialize and scan QR again.');
            emitToUser(username, 'auth_failure', '⚠️ WhatsApp disconnected! Please re-initialize.');
            emitToUser(username, 'all-messages-sent', null);
            return;
        }

        for (let i = 0; i < contacts.length; i++) {
            const contact = contacts[i];
            const number = contact.phone.trim();

            try {
                let cleanedNumber = number.replace(/\D/g, '');
                if (cleanedNumber.length === 10) {
                    cleanedNumber = '92' + cleanedNumber;
                } else if (cleanedNumber.startsWith('0') && cleanedNumber.length === 11) {
                    cleanedNumber = '92' + cleanedNumber.substring(1);
                }

                const chatId = `${cleanedNumber}@c.us`;

                const { msg: chosenMessage, idx: variantIdx } = pickVariantResult();
                let personalizedMessage = chosenMessage;
                if (contact.name) personalizedMessage = chosenMessage.replace(/\{name\}/gi, contact.name);

                const chosenMedia = resolveMedia(variantIdx);

                if (chosenMedia && chosenMedia.path) {
                    try {
                        const mediaPath = path.join(__dirname, 'uploads', path.basename(chosenMedia.path));
                        const mediaBytes = fs.readFileSync(mediaPath, { encoding: 'base64' });
                        const messageMedia = new MessageMedia(chosenMedia.mimetype, mediaBytes, chosenMedia.originalname);
                        await ud.client.sendMessage(chatId, messageMedia, { caption: personalizedMessage });
                    } catch (mediaErr) {
                        console.error(`[${username}] Media send failed, falling back to text:`, mediaErr.message);
                        await ud.client.sendMessage(chatId, `[Media Failed] ${personalizedMessage}`);
                    }
                } else {
                    await ud.client.sendMessage(chatId, personalizedMessage);
                }

                console.log(`[${username}] Sent to ${contact.name || 'Unnamed'} (${number}) [Variant ${variantIdx + 1}]`);

                // ── Log success to MongoDB ──────────────────────────────────
                SendLog.create({
                    username,
                    recipientPhone: contact.phone,
                    recipientName:  contact.name || '',
                    status:         'success',
                    variantIndex:   variantIdx
                }).catch(err => console.error(`[${username}] SendLog write error:`, err.message));

                socket.emit('message-sent', { number: contact.phone, name: contact.name, success: true });

            } catch (error) {
                console.error(`[${username}] Failed to send to ${number}:`, error.message);

                const isBrokenClient =
                    (error.message && error.message.includes('Cannot read properties of null')) ||
                    (error.message && error.message.includes('Cannot read properties of undefined')) ||
                    (error.message && error.message.includes('detached Frame')) ||
                    (error.message && error.message.includes('Session closed')) ||
                    (error.message && error.message.includes('Target closed')) ||
                    (error.message && error.message.includes('Protocol error')) ||
                    (error.message && error.message.includes('getChat')) ||
                    (error.message && error.message.includes('Execution context'));

                // ── Log failure to MongoDB ──────────────────────────────────
                SendLog.create({
                    username,
                    recipientPhone: contact.phone,
                    recipientName:  contact.name || '',
                    status:         'failed',
                    errorMessage:   error.message || 'Unknown error'
                }).catch(err => console.error(`[${username}] SendLog write error:`, err.message));

                if (isBrokenClient) {
                    console.log(`[${username}] Browser is dead! Resetting client...`);
                    ud.isReady = false;
                    ud.client = null;
                    ud.isSending = false;
                    emitToUser(username, 'message-sent', {
                        number: contact.phone, name: contact.name, success: false,
                        error: 'WhatsApp session lost. Please re-initialize WhatsApp.'
                    });
                    emitToUser(username, 'all-messages-sent', null);
                    emitToUser(username, 'auth_failure', '⚠️ WhatsApp disconnected! Please re-initialize.');
                    return;
                }

                socket.emit('message-sent', {
                    number: contact.phone, name: contact.name, success: false,
                    error: error.message || 'Unknown error'
                });
            }

            if (i < contacts.length - 1) {
                const minMs = minInterval * 1000;
                const maxMs = maxInterval * 1000;
                const delay = minMs + Math.random() * (maxMs - minMs);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        console.log(`[${username}] Finished sending`);
        ud.isSending = false;
        emitToUser(username, 'all-messages-sent', null);
    });

    // ── Disconnect ───────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
        console.log(`[${username}] Socket disconnected`);
        ud.sockets = ud.sockets.filter(s => s !== socket);
    });
});

// ─── Server start + auto-init saved sessions ──────────────────────────────────
const PORT = process.env.PORT || 3003;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on http://0.0.0.0:${PORT}`);
});

async function runAutoInit() {
    try {
        const users = await User.find({}, 'username').lean();
        for (const { username } of users) {
            const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-${username}`);
            if (fs.existsSync(sessionPath)) {
                console.log(`[AUTO-INIT] Restoring session for user: ${username}`);
                const ud = getUserData(username);
                if (!ud.client) {
                    await createClient(username);
                    ud.client.initialize().catch(err => {
                        console.error(`[AUTO-INIT][${username}] Error:`, err.message);
                        ud.client = null;
                        ud.isReady = false;
                    });
                }
            }
        }
    } catch (err) {
        console.error('[AUTO-INIT] Error fetching users:', err.message);
    }
}
