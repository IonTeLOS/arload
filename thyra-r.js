import 'dotenv/config'

function createConfig() {
  return {
    port: process.env.PORT || 3000,
    wallet: {
      path: process.env.WALLET_PATH || './thyra-wallet.json'
    },
    database: {
      enabled: process.env.DB_ENABLED === 'true',
      path: process.env.DB_PATH || './thyra-uploads.db'
    },
    apiKey: process.env.API_KEY || null,
    logLevel: process.env.LOG_LEVEL || 'info',
    nodeEnv: process.env.NODE_ENV || 'development'
  };
}

async function requireApiKey(request, reply, config) {
  console.log('🔍 Auth middleware called');
  console.log('🔍 Config API Key:', config.apiKey);
  console.log('🔍 Request headers:', request.headers['x-api-key'], request.headers['authorization']);

  if (!config.apiKey) {
    console.log('🔍 No API key configured, skipping auth');
    return; // No auth required when API_KEY not set
  }

  const providedKey = request.headers['x-api-key'] || request.headers['authorization']?.replace('Bearer ', '');

  console.log('🔍 Provided key:', providedKey);
  console.log('🔍 Expected key:', config.apiKey);
  console.log('🔍 Keys match:', providedKey === config.apiKey);

  if (!providedKey || providedKey !== config.apiKey) {
    console.log('🔍 Auth failed, returning 401');
    return reply.code(401).send({
      success: false,
      error: 'UNAUTHORIZED',
      message: 'Valid API key required'
    });
  }

  console.log('🔍 Auth passed');
}

import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ThyraAPICore {
  constructor() {
    this.arweaveClient = null;
    this.arweaveJWK = null;
    this.driveKey = null;
    this.initialized = false;
    this.config = {};
    this.thyraDriveId = null;
    this.thyraRootFolderId = null;
  }

  async initialize(config) {
    this.config = config;

    const Arweave = (await import('arweave')).default;

    // Initialize Arweave client
    this.arweaveClient = Arweave.init({
      host: 'arweave.net',
      port: 443,
      protocol: 'https'
    });

    // Load or create wallet
    await this.initializeWallet();

    // Create or load drive
    await this.initializeDrive();

    // Generate drive key
    this.driveKey = await this.generateDriveKey();

    this.initialized = true;
    console.log('✅ Thyra API Core initialized (Direct HTTP mode)');
  }

  async initializeWallet() {
    try {
      // Try to load existing wallet
      const walletPath = this.config.wallet?.path || './thyra-wallet.json';
      const walletData = await fs.promises.readFile(walletPath, 'utf8');
      this.arweaveJWK = JSON.parse(walletData);

      const address = await this.arweaveClient.wallets.jwkToAddress(this.arweaveJWK);
      console.log('📁 Loaded existing wallet:', address);

    } catch (error) {
      // Create new wallet if none exists
      console.log('🔧 Creating new wallet...');
      this.arweaveJWK = await this.arweaveClient.wallets.generate();

      const address = await this.arweaveClient.wallets.jwkToAddress(this.arweaveJWK);
      console.log('✨ New wallet created:', address);

      // Try to save wallet (may fail in stateless environments)
      try {
        const walletPath = this.config.wallet?.path || './thyra-wallet.json';
        await fs.promises.writeFile(walletPath, JSON.stringify(this.arweaveJWK, null, 2));
        console.log('💾 Wallet saved to:', walletPath);
      } catch (saveError) {
        console.log('⚠️  Could not save wallet (stateless environment?)');
      }
    }
  }

  async initializeDrive() {
    const driveStatePath = './thyra-drive-state.json';

    try {
      // Try to load existing drive
      const driveState = JSON.parse(await fs.promises.readFile(driveStatePath, 'utf8'));
      this.thyraDriveId = driveState.driveId;
      this.thyraRootFolderId = driveState.rootFolderId;

      console.log('📂 Thyra Uploads drive found:', this.thyraDriveId);
      console.log('🎯 Drive URL: https://app.ardrive.io/#/drives/' + this.thyraDriveId);
      console.log('🔍 Drive Transaction:', driveState.driveTxId);
      console.log('🔍 Root Folder Transaction:', driveState.rootFolderTxId);
      return;
    } catch (error) {
      console.log('🔧 Creating "Thyra Uploads" drive...');
    }

    try {
      // Generate UUIDs
      const driveId = crypto.randomUUID();
      const rootFolderId = crypto.randomUUID();
      const currentUnixTime = Math.floor(Date.now() / 1000);

      console.log('📋 Generated Drive ID:', driveId);
      console.log('📋 Generated Root Folder ID:', rootFolderId);
      console.log('📋 Unix Time:', currentUnixTime);

      // Create drive metadata - exactly like ArDrive CLI does
      const driveMetadata = {
        name: 'Thyra Uploads',
        rootFolderId: rootFolderId
      };

      console.log('📄 Drive Metadata:', JSON.stringify(driveMetadata, null, 2));

      // Drive tags - matching ArDrive CLI format exactly
      const driveTags = [
        { name: 'App-Name', value: 'Thyra' },
        { name: 'App-Version', value: '1.0.0' },
        { name: 'ArFS', value: '0.11' },
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Drive-Id', value: driveId },
        { name: 'Drive-Privacy', value: 'public' },
        { name: 'Entity-Type', value: 'drive' },
        { name: 'Unix-Time', value: currentUnixTime.toString() }
      ];

      console.log('🏷️  Drive Tags:', JSON.stringify(driveTags, null, 2));

      // Upload drive entity
      console.log('📤 Uploading drive entity...');
      const driveResult = await this.uploadData(
        JSON.stringify(driveMetadata),
        'application/json',
        driveTags
      );

      console.log('✅ Drive uploaded:', driveResult.id);
      console.log('🔗 Drive transaction: https://arweave.net/' + driveResult.id);

      // Create root folder metadata
      const rootFolderMetadata = {
        name: 'Root'
      };

      console.log('📄 Root Folder Metadata:', JSON.stringify(rootFolderMetadata, null, 2));

      // Root folder tags - matching ArDrive CLI format exactly
      const folderTags = [
        { name: 'App-Name', value: 'Thyra' },
        { name: 'App-Version', value: '1.0.0' },
        { name: 'ArFS', value: '0.11' },
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Drive-Id', value: driveId },
        { name: 'Entity-Type', value: 'folder' },
        { name: 'Folder-Id', value: rootFolderId },
        { name: 'Unix-Time', value: currentUnixTime.toString() }
      ];

      console.log('🏷️  Root Folder Tags:', JSON.stringify(folderTags, null, 2));

      // Upload root folder entity
      console.log('📤 Uploading root folder entity...');
      const folderResult = await this.uploadData(
        JSON.stringify(rootFolderMetadata),
        'application/json',
        folderTags
      );

      console.log('✅ Root folder uploaded:', folderResult.id);
      console.log('🔗 Folder transaction: https://arweave.net/' + folderResult.id);

      // Save drive state
      const driveState = {
        driveId: driveId,
        rootFolderId: rootFolderId,
        driveTxId: driveResult.id,
        rootFolderTxId: folderResult.id,
        createdAt: Date.now(),
        unixTime: currentUnixTime
      };

      console.log('💾 Saving drive state:', JSON.stringify(driveState, null, 2));

      await fs.promises.writeFile(driveStatePath, JSON.stringify(driveState, null, 2));

      this.thyraDriveId = driveId;
      this.thyraRootFolderId = rootFolderId;

      console.log('✨ Drive created successfully!');
      console.log('🎯 ArDrive URL: https://app.ardrive.io/#/drives/' + driveId);
      console.log('📊 Wait 10-15 minutes for ArDrive indexing');
      console.log('🔍 You can check transactions:');
      console.log('   Drive: https://arweave.net/' + driveResult.id);
      console.log('   Folder: https://arweave.net/' + folderResult.id);

    } catch (error) {
      console.error('❌ Drive creation failed:', error);
      console.error('📋 Error details:', error.stack);
      console.log('📁 Continuing without managed drive');
    }
  }

  async uploadData(content, contentType, tags = []) {
    // TODO: replace arbundles because of deprecation
    const { createData, ArweaveSigner } = await import('arbundles');

    const dataBuffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const signer = new ArweaveSigner(this.arweaveJWK);
    const dataItem = createData(dataBuffer, signer, { tags });
    await dataItem.sign(signer);

    const response = await fetch('https://upload.ardrive.io/v1/tx', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Accept': 'application/json'
      },
      body: dataItem.getRaw()
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    return await response.json();
  }

  async generateDriveKey() {
    const key = crypto.randomBytes(32);
    return key;
  }

  async getWalletAddress() {
    return await this.arweaveClient.wallets.jwkToAddress(this.arweaveJWK);
  }

  async exportWallet(exportPath) {
    const finalPath = exportPath || './thyra-wallet.json';
    await fs.promises.writeFile(finalPath, JSON.stringify(this.arweaveJWK, null, 2));
    return path.resolve(finalPath);
  }

  async uploadContent(content, options = {}) {
    const {
      encryption = 'random',
      customKey = null,
      contentType = 'application/octet-stream',
      filename = null
    } = options;

    let encryptedData, encryptionKey;

    // Handle encryption
    if (encryption === 'none') {
      encryptedData = content;
    } else {
      if (encryption === 'custom' && customKey) {
        encryptionKey = Buffer.from(JSON.stringify(customKey));
      } else if (encryption === 'random') {
        encryptionKey = crypto.randomBytes(32);
      } else {
        encryptionKey = this.driveKey;
      }

      encryptedData = await this.encryptContent(content, encryptionKey);
    }

    const dataBuffer = Buffer.isBuffer(encryptedData) ? encryptedData : Buffer.from(encryptedData);

    // Prepare tags - keep it simple
    const tags = [
      { name: 'Content-Type', value: contentType },
      { name: 'App-Name', value: 'Thyra' }
    ];

    if (filename) {
      tags.push({ name: 'Original-Filename', value: filename });
    }

    // If we have a drive, add basic ArFS tags for file organization
    if (this.thyraDriveId && this.thyraRootFolderId) {
      const fileId = crypto.randomUUID();
      tags.push(
        { name: 'Entity-Type', value: 'file' },
        { name: 'Drive-Id', value: this.thyraDriveId },
        { name: 'File-Id', value: fileId },
        { name: 'Parent-Folder-Id', value: this.thyraRootFolderId },
        { name: 'ArFS', value: '0.11' }
      );
    }

    try {
      const result = await this.uploadData(dataBuffer, contentType, tags);

      return {
        arweaveId: result.id,
        url: `https://arweave.net/${result.id}`,
        encrypted: encryption !== 'none',
        encryptionKey: encryptionKey,
        size: dataBuffer.length
      };

    } catch (error) {
      console.error('Direct HTTP upload failed:', error.message);
      throw new Error(`Upload failed: ${error.message}`);
    }
  }

  async encryptContent(content, key) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key.slice(0, 32), iv);

    let encrypted = cipher.update(Buffer.isBuffer(content) ? content : Buffer.from(content));
    encrypted = Buffer.concat([encrypted, cipher.final()]);

    return JSON.stringify({
      encrypted: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      algorithm: 'aes-256-cbc'
    });
  }

  async decryptContent(encryptedData, key) {
    const data = JSON.parse(encryptedData);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key.slice(0, 32), Buffer.from(data.iv, 'base64'));

    let decrypted = decipher.update(Buffer.from(data.encrypted, 'base64'));
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted;
  }
}

// Database helper
class DatabaseManager {
  constructor(config) {
    this.enabled = config.database?.enabled || false;
    this.dbPath = config.database?.path || './uploads.db';
    this.db = null;
  }

  async initialize() {
    if (!this.enabled) return;

    this.db = new sqlite3.Database(this.dbPath);
    const run = promisify(this.db.run.bind(this.db));

    await run(`
      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        share_url TEXT,
        timestamp INTEGER,
        encrypted BOOLEAN,
        size INTEGER,
        note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('📊 Database initialized:', this.dbPath);
  }

  async saveUpload(uploadData) {
    if (!this.enabled || !this.db) return;

    const run = promisify(this.db.run.bind(this.db));
    await run(
      `INSERT OR REPLACE INTO uploads (id, url, share_url, timestamp, encrypted, size, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uploadData.id,
        uploadData.url,
        uploadData.shareUrl,
        uploadData.timestamp,
        uploadData.encrypted,
        uploadData.size,
        uploadData.note
      ]
    );
  }

  async getUploads(filters = {}) {
    if (!this.enabled || !this.db) return [];

    const all = promisify(this.db.all.bind(this.db));
    let query = 'SELECT * FROM uploads WHERE 1=1';
    const params = [];

    if (filters.since) {
      query += ' AND timestamp >= ?';
      params.push(filters.since);
    }

    if (filters.id) {
      query += ' AND id LIKE ?';
      params.push(`%${filters.id}%`);
    }

    if (filters.note) {
      query += ' AND note LIKE ?';
      params.push(`%${filters.note}%`);
    }

    query += ' ORDER BY timestamp DESC';

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    return await all(query, params);
  }
}

// Updated start function to accept config and return instances
const start = async (providedConfig = null) => {
  // Create config from environment variables (after CLI has set them)
  const config = providedConfig || createConfig();

  console.log('🔧 Using config:', {
    port: config.port,
    apiKey: config.apiKey ? '***' + config.apiKey.slice(-3) : 'None',
    database: config.database.enabled,
    logLevel: config.logLevel
  });

  const fastify = Fastify({
    logger: {
      level: config.logLevel,
      transport: config.nodeEnv === 'development' ? {
        target: 'pino-pretty'
      } : undefined
    }
  });

  // Register plugins
  await fastify.register(multipart);
  await fastify.register(cors);

  // Register global authentication middleware with config
  fastify.addHook('preHandler', async (request, reply) => {
    // Only apply auth to API routes, skip health, docs, and share routes
    if (request.url.startsWith('/api/') &&
        !request.url.startsWith('/api/health')) {
      await requireApiKey(request, reply, config);
    }
  });

  // Initialize Thyra core
  const thyraCore = new ThyraAPICore();
  await thyraCore.initialize(config);

  // Initialize database
  const dbManager = new DatabaseManager(config);
  await dbManager.initialize();

  // Routes with access to instances and config
  fastify.post('/api/upload', async (request, reply) => {
    try {
      if (!thyraCore.initialized) {
        throw new Error('Service not initialized');
      }

      let content, contentType, filename;
      const timestamp = Date.now();
      let userProvidedId = null;
      let noteValue = null;
      let storeValue = true;

      const uploadOptions = {
        encryption: 'random',
        customKey: null,
        contentType: 'application/octet-stream',
        filename: null
      };

      // Handle different content types
      if (request.isMultipart()) {
        const data = await request.file();
        const chunks = [];

        for await (const chunk of data.file) {
          chunks.push(chunk);
        }

        content = Buffer.concat(chunks);
        contentType = data.mimetype;
        filename = data.filename;

        const fields = {};
        const parts = data.fields;
        if (parts) {
          for (const [key, field] of Object.entries(parts)) {
            if (field && field.value !== undefined) {
              fields[key] = field.value;
            }
          }
        }

        if (fields.encryption) uploadOptions.encryption = fields.encryption;
        if (fields.id) userProvidedId = fields.id;
        if (fields.note) noteValue = fields.note;
        if (fields.store !== undefined) storeValue = fields.store !== 'false';

      } else if (request.headers['content-type']?.includes('application/json')) {
        content = request.body?.message;
        contentType = 'text/plain';

        if (request.body?.encryption) uploadOptions.encryption = request.body.encryption;
        if (request.body?.customKey) uploadOptions.customKey = request.body.customKey;
        if (request.body?.id) userProvidedId = request.body.id;
        if (request.body?.note) noteValue = request.body.note;
        if (request.body?.store !== undefined) storeValue = request.body.store;

      } else {
        content = request.body;
        contentType = 'text/plain';
      }

      if (!content) {
        return reply.code(400).send({
          success: false,
          error: 'MISSING_CONTENT',
          message: 'No content provided'
        });
      }

      const uploadId = userProvidedId || crypto.randomUUID();
      const size = Buffer.isBuffer(content) ? content.length : Buffer.from(content).length;

      if (size > 100 * 1024) {
        fastify.log.warn(`Large upload: ${size} bytes`);
      }

      uploadOptions.contentType = contentType;
      uploadOptions.filename = filename;

      const result = await thyraCore.uploadContent(content, uploadOptions);

      // Fixed share URL generation
      let shareUrl = null;
      if (result.encrypted && result.encryptionKey) {
        // Ensure the encryption key is properly base64 encoded
        let keyB64;
        if (Buffer.isBuffer(result.encryptionKey)) {
          keyB64 = result.encryptionKey.toString('base64');
        } else if (typeof result.encryptionKey === 'string') {
          keyB64 = result.encryptionKey;
        } else {
          keyB64 = Buffer.from(result.encryptionKey).toString('base64');
        }

        // URL encode the base64 key to handle special characters
        const encodedKey = encodeURIComponent(keyB64);
        shareUrl = `${request.protocol}://${request.headers.host}/share/${result.arweaveId}#decrypt=${encodedKey}`;

        console.log('🔑 Encryption key (base64):', keyB64.substring(0, 20) + '...');
      }

      const response = {
        success: true,
        id: uploadId,
        url: result.url,
        shareUrl,
        timestamp,
        encrypted: result.encrypted,
        size: result.size
      };

      if (dbManager.enabled && storeValue !== false) {
        await dbManager.saveUpload({
          id: uploadId,
          url: result.url,
          shareUrl,
          timestamp,
          encrypted: result.encrypted,
          size: result.size,
          note: noteValue || null
        });
      }

      reply.send(response);

    } catch (error) {
      fastify.log.error(error);
      reply.code(500).send({
        success: false,
        error: 'UPLOAD_FAILED',
        message: error.message
      });
    }
  });

  fastify.get('/api/wallet/address', async (request, reply) => {
    try {
      const address = await thyraCore.getWalletAddress();
      reply.send({
        success: true,
        address
      });
    } catch (error) {
      reply.code(500).send({
        success: false,
        error: 'WALLET_ERROR',
        message: error.message
      });
    }
  });

  fastify.post('/api/wallet/export', async (request, reply) => {
    try {
      const exportPath = await thyraCore.exportWallet(request.body?.path);
      const address = await thyraCore.getWalletAddress();

      reply.send({
        success: true,
        walletPath: exportPath,
        address
      });
    } catch (error) {
      reply.code(500).send({
        success: false,
        error: 'EXPORT_FAILED',
        message: error.message
      });
    }
  });

  fastify.get('/api/uploads', async (request, reply) => {
    // Check authentication using the config passed to this function
    if (config.apiKey) {
      const providedKey = request.headers['x-api-key'] || request.headers['authorization']?.replace('Bearer ', '');

      if (!providedKey || providedKey !== config.apiKey) {
        return reply.code(401).send({
          success: false,
          error: 'UNAUTHORIZED',
          message: 'Valid API key required'
        });
      }
    }

    if (!dbManager.enabled) {
      return reply.code(404).send({
        success: false,
        error: 'DATABASE_DISABLED',
        message: 'Database mode not enabled'
      });
    }

    try {
      const uploads = await dbManager.getUploads(request.query);
      reply.send({
        success: true,
        uploads
      });
    } catch (error) {
      reply.code(500).send({
        success: false,
        error: 'DATABASE_ERROR',
        message: error.message
      });
    }
  });

  // Fixed share endpoint for decryption
  fastify.get('/share/:arweaveId', async (request, reply) => {
    const { arweaveId } = request.params;

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Decrypting Content...</title>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
        .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .spinner { border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .error { color: #e74c3c; margin: 20px; padding: 15px; background: #fdf2f2; border-radius: 5px; }
        .success { color: #27ae60; margin: 20px; padding: 15px; background: #f2fdf2; border-radius: 5px; }
        .debug { color: #7f8c8d; font-size: 0.9em; margin-top: 20px; padding: 10px; background: #f8f9fa; border-radius: 5px; text-align: left; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🔓 Decrypting Content</h1>
        <div class="spinner" id="spinner"></div>
        <div id="status">Please wait while we decrypt your content...</div>
        <div id="debug" class="debug" style="display: none;"></div>
      </div>

      <script>
        function addDebug(message) {
          const debugEl = document.getElementById('debug');
          debugEl.style.display = 'block';
          debugEl.innerHTML += message + '<br>';
          console.log(message);
        }

        async function decryptAndDownload() {
          try {
            addDebug('Starting decryption process...');

            const fragment = window.location.hash.substring(1);
            addDebug('URL fragment: ' + fragment);

            if (!fragment.startsWith('decrypt=')) {
              throw new Error('Missing or invalid decryption key in URL. Expected format: #decrypt=<base64-key>');
            }

            const keyParam = fragment.split('=')[1];
            if (!keyParam) {
              throw new Error('No decryption key found in URL fragment');
            }

            addDebug('Key parameter length: ' + keyParam.length);

            document.getElementById('status').innerHTML = 'Fetching encrypted content from Arweave...';

            const arweaveUrl = 'https://arweave.net/${arweaveId}';
            addDebug('Fetching from: ' + arweaveUrl);

            const response = await fetch(arweaveUrl);
            if (!response.ok) {
              throw new Error(\`Content not found on Arweave (HTTP \${response.status})\`);
            }

            const encryptedData = await response.json();
            addDebug('Encrypted data received. Algorithm: ' + encryptedData.algorithm);

            document.getElementById('status').innerHTML = 'Decrypting content...';

            // Clean and validate the base64 key
            let cleanKey = decodeURIComponent(keyParam).replace(/\\s/g, '');
            addDebug('Cleaned key length: ' + cleanKey.length);

            // Validate base64 format
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleanKey)) {
              throw new Error('Invalid base64 key format');
            }

            // Decode the base64 key
            const keyBytes = new Uint8Array(atob(cleanKey).split('').map(c => c.charCodeAt(0)));
            addDebug('Key bytes length: ' + keyBytes.length);

            if (keyBytes.length !== 32) {
              throw new Error(\`Invalid key length: expected 32 bytes, got \${keyBytes.length} bytes\`);
            }

            // Import the key for decryption
            const cryptoKey = await crypto.subtle.importKey(
              'raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']
            );

            // Decrypt the data
            const iv = new Uint8Array(atob(encryptedData.iv).split('').map(c => c.charCodeAt(0)));
            const encrypted = new Uint8Array(atob(encryptedData.encrypted).split('').map(c => c.charCodeAt(0)));

            const decrypted = await crypto.subtle.decrypt(
              { name: 'AES-CBC', iv: iv }, cryptoKey, encrypted
            );

            const decryptedData = new Uint8Array(decrypted);

            // Determine if it's text or binary
            let isText = true;
            for (let i = 0; i < Math.min(100, decryptedData.length); i++) {
              if (decryptedData[i] === 0 || (decryptedData[i] < 32 && ![9,10,13].includes(decryptedData[i]))) {
                isText = false;
                break;
              }
            }

            let blob, filename = 'decrypted_${arweaveId}';
            if (isText) {
              const text = new TextDecoder().decode(decryptedData);
              blob = new Blob([text], { type: 'text/plain' });
              filename += '.txt';
            } else {
              blob = new Blob([decryptedData], { type: 'application/octet-stream' });
            }

            // Download the decrypted content
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            document.getElementById('spinner').style.display = 'none';
            document.getElementById('status').innerHTML = '<div class="success">✅ Content decrypted and downloaded!</div>';

          } catch (error) {
            console.error('Decryption error:', error);
            document.getElementById('spinner').style.display = 'none';
            document.getElementById('status').innerHTML = '<div class="error">❌ Error: ' + error.message + '</div>';
            addDebug('Error: ' + error.message);
          }
        }

        window.onload = decryptAndDownload;
      </script>
    </body>
    </html>
    `;

    reply.type('text/html').send(html);
  });

  fastify.get('/api/health', (request, reply) => {
    const healthData = {
      success: true,
      status: 'healthy',
      uptime: Math.floor(process.uptime()),
      initialized: thyraCore?.initialized || false,
      database: dbManager?.enabled || false,
      environment: config.nodeEnv,
      timestamp: new Date().toISOString()
    };

    // Add memory info in development
    if (config.nodeEnv === 'development') {
      healthData.memory = process.memoryUsage();
    }

    reply.send(healthData);
  });

  // Simple API documentation endpoint
  fastify.get('/docs', (request, reply) => {
    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Thyra API Documentation</title>
      <style>
        body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; line-height: 1.6; }
        h1, h2 { color: #333; }
        code { background: #f4f4f4; padding: 2px 4px; border-radius: 3px; }
        pre { background: #f4f4f4; padding: 10px; border-radius: 5px; overflow-x: auto; }
        .endpoint { margin-bottom: 30px; border: 1px solid #ddd; padding: 15px; border-radius: 5px; }
        .method { font-weight: bold; color: white; padding: 2px 8px; border-radius: 3px; }
        .post { background: #28a745; }
        .get { background: #007bff; }
      </style>
    </head>
    <body>
      <h1>Thyra Storage API</h1>
      <p>Simple API for storing messages and files on Arweave with optional encryption</p>

      <div class="endpoint">
        <h2><span class="method post">POST</span> /api/upload</h2>
        <p>Upload a message or file to Arweave</p>
        <pre>
// JSON upload
curl -X POST http://localhost:3000/api/upload \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Hello World!"}'

// File upload
curl -X POST http://localhost:3000/api/upload \\
  -F "file=@example.txt"
        </pre>
      </div>

      <div class="endpoint">
        <h2><span class="method get">GET</span> /api/wallet/address</h2>
        <p>Get the server wallet address</p>
      </div>

      <div class="endpoint">
        <h2><span class="method get">GET</span> /api/uploads</h2>
        <p>List recent uploads (requires database enabled)</p>
      </div>

      <div class="endpoint">
        <h2><span class="method get">GET</span> /api/health</h2>
        <p>Check server health status</p>
      </div>

      <div class="endpoint">
        <h2><span class="method get">GET</span> /share/:arweaveId</h2>
        <p>Decrypt and download encrypted content using URL fragment key</p>
      </div>
    </body>
    </html>
    `;

    reply.type('text/html').send(html);
  });

  // Error handling for production
  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });

  try {
    // Start server
    await fastify.listen({
      port: config.port,
      host: '0.0.0.0'
    });

    console.log(`🚀 Thyra API Server running on port ${config.port}`);
    console.log(`📚 API docs available at http://localhost:${config.port}/docs`);
    console.log(`🌍 Environment: ${config.nodeEnv}`);

    if (config.apiKey) {
      console.log(`🔐 API Key authentication enabled`);
    } else {
      console.log(`🔓 No API key configured - public access`);
    }

    if (dbManager.enabled) {
      console.log(`📊 Database enabled: ${dbManager.dbPath}`);
    }

    return { fastify, config, thyraCore, dbManager };

  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Only start if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  start();
}

export { start, createConfig };
