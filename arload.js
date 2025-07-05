// netlify/functions/arload.js
const crypto = require('crypto');

// Configuration constants
const CONFIG = {
  MAX_SIZE_BYTES: 100 * 1024, // 100KB final upload limit
  MAX_RAW_FOR_ENCRYPTION: 72 * 1024, // 72KB max raw content that will be encrypted
  MAX_ALREADY_ENCRYPTED: 95 * 1024, // 95KB max for already encrypted or unencrypted content
  MAX_DECRYPTION_SIZE: 1024 * 1024, // 1MB max for decryption (larger since we're just fetching)
  ENCRYPTION_OVERHEAD_PERCENT: 37, // Real-world encryption overhead: ~37%
  ARWEAVE_HOST: 'arweave.net',
  TURBO_UPLOAD_URL: 'https://upload.ardrive.io/v1/tx',
  TIMEOUT_THRESHOLD: 2000, // 2000 seconds - if upload took longer, delegate to fresh function
  MAX_FUNCTION_TIMEOUT: 9500, // 9.5 seconds - leave 500ms buffer
  
  // Admin controls
  ADMIN: {
    DECRYPTION_ENABLED: true, // Set to false to disable decryption endpoint
    DOMAIN_RESTRICTION_ENABLED: false, // Set to true to enable domain restrictions
    LOGGING_ENABLED: true, // Set to false to disable all console.log for privacy
    ALLOWED_DOMAINS: [
      'komvos.net',
      'localhost:3000',
      'localhost:8080'
      // Add more domains as needed
    ]
  }
};

// Core uploader class
class MinimalThyraUploader {
  constructor() {
    this.arweave = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    
    const Arweave = (await import('arweave')).default;
    this.arweave = Arweave.init({
      host: CONFIG.ARWEAVE_HOST,
      port: 443,
      protocol: 'https'
    });
    
    this.initialized = true;
  }

  async createEphemeralWallet() {
    await this.initialize();
    return await this.arweave.wallets.generate();
  }

  async generateEncryptionKey() {
    return crypto.randomBytes(32);
  }

  async encryptContent(content, key) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(content);
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      encrypted: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      algorithm: 'aes-256-gcm'
    };
  }

  async uploadToArweave(content, tags = []) {
    const wallet = await this.createEphemeralWallet();
    
    const { createData, ArweaveSigner } = await import('arbundles');
    const signer = new ArweaveSigner(wallet);

    const dataItem = createData(content, signer, {
      tags: [
        { name: 'Content-Type', value: 'application/octet-stream' },
        { name: 'App-Name', value: 'MinimalThyra' },
        { name: 'Timestamp', value: Date.now().toString() },
        ...tags
      ]
    });

    await dataItem.sign(signer);

    const response = await fetch(CONFIG.TURBO_UPLOAD_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Accept': 'application/json'
      },
      body: dataItem.getRaw()
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Arweave upload failed: ${response.status} - ${errorText}`);
    }

    const result = await response.json();
    return { 
      id: result.id, 
      wallet: wallet
    };
  }

  createShareUrl(arweaveId, encryptionKey, baseUrl, contentType = null) {
    const keyB64 = encryptionKey.toString('base64');
    let shareUrl = `${baseUrl}/s/?url=${btoa(`https://arweave.net/${arweaveId}`)}&key=${encodeURIComponent(keyB64)}`;
    
    if (contentType) {
      shareUrl += `&type=${encodeURIComponent(contentType)}`;
    }
    
    return shareUrl;
  }

  validateSize(content, willEncrypt = true) {
    const baseSize = Buffer.isBuffer(content) ? content.length : Buffer.from(content).length;
    
    if (willEncrypt) {
      if (baseSize > CONFIG.MAX_RAW_FOR_ENCRYPTION) {
        throw new Error(`Content too large for encryption. Max: ${Math.floor(CONFIG.MAX_RAW_FOR_ENCRYPTION / 1024)}KB, Actual: ${Math.floor(baseSize / 1024)}KB. Use encrypt=false for larger content.`);
      }
      
      const estimatedEncryptedSize = Math.ceil(baseSize * (1 + CONFIG.ENCRYPTION_OVERHEAD_PERCENT / 100));
      
      if (estimatedEncryptedSize > CONFIG.MAX_SIZE_BYTES) {
        throw new Error(`Encrypted content would be too large. Estimated: ${Math.floor(estimatedEncryptedSize / 1024)}KB, Max: ${Math.floor(CONFIG.MAX_SIZE_BYTES / 1024)}KB`);
      }
      
      return { baseSize, estimatedFinalSize: estimatedEncryptedSize };
      
    } else {
      if (baseSize > CONFIG.MAX_ALREADY_ENCRYPTED) {
        throw new Error(`Content too large. Max: ${Math.floor(CONFIG.MAX_ALREADY_ENCRYPTED / 1024)}KB, Actual: ${Math.floor(baseSize / 1024)}KB`);
      }
      
      return { baseSize, estimatedFinalSize: baseSize };
    }
  }

  validateEncryptionKey(customKey) {
    if (!customKey) return null;
    
    try {
      const keyBuffer = Buffer.from(customKey, 'base64');
      if (keyBuffer.length !== 32) {
        throw new Error(`Invalid key length: expected 32 bytes, got ${keyBuffer.length} bytes`);
      }
      return keyBuffer;
    } catch (err) {
      if (err.message.includes('Invalid key length')) {
        throw err;
      }
      throw new Error('Invalid base64 key format');
    }
  }

  // Decrypt content using AES-GCM
  async decryptContent(encryptedData, key) {
    if (!encryptedData.algorithm || encryptedData.algorithm !== 'aes-256-gcm') {
      throw new Error('Unsupported encryption algorithm');
    }

    const iv = Buffer.from(encryptedData.iv, 'base64');
    const authTag = Buffer.from(encryptedData.authTag, 'base64');
    const encrypted = Buffer.from(encryptedData.encrypted, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted;
  }

  // Detect content type from file
  detectContentType(buffer, filename = '', mimeType = '') {
    // Use provided mime type if available
    if (mimeType && mimeType !== 'application/octet-stream') {
      return mimeType;
    }

    // Detect from file extension
    const ext = filename.toLowerCase().split('.').pop();
    const extensionMap = {
      'txt': 'text/plain',
      'html': 'text/html',
      'htm': 'text/html',
      'css': 'text/css',
      'js': 'application/javascript',
      'json': 'application/json',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'zip': 'application/zip'
    };

    if (extensionMap[ext]) {
      return extensionMap[ext];
    }

    // Detect from file signature (magic bytes)
    const bytes = buffer.slice(0, 16);
    
    // Images
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) return 'image/jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
    if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
    
    // Documents
    if (bytes[0] === 0x25 && bytes[1] === 0x50) return 'application/pdf'; // %PDF
    if (bytes[0] === 0x50 && bytes[1] === 0x4B) return 'application/zip'; // PK (zip/docx)
    
    // Try to detect text
    const isText = this.isTextContent(bytes);
    if (isText) {
      const text = buffer.toString('utf8', 0, Math.min(1000, buffer.length));
      if (text.includes('<!DOCTYPE') || text.includes('<html')) {
        return 'text/html';
      }
      return 'text/plain';
    }

    return 'application/octet-stream';
  }

  isTextContent(bytes) {
    for (let i = 0; i < Math.min(100, bytes.length); i++) {
      const byte = bytes[i];
      if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
        return false;
      }
    }
    return true;
  }
}

// Privacy-aware logging functions
function safeLog(...args) {
  if (CONFIG.ADMIN.LOGGING_ENABLED) {
    console.log(...args);
  }
}

function safeError(...args) {
  if (CONFIG.ADMIN.LOGGING_ENABLED) {
    console.error(...args);
  }
}

// Helper function to check domain restrictions
function checkDomainAccess(headers) {
  if (!CONFIG.ADMIN.DOMAIN_RESTRICTION_ENABLED) {
    return { allowed: true }; // Domain restrictions disabled
  }

  const origin = headers.origin || headers.referer;
  
  if (!origin) {
    return { 
      allowed: false, 
      error: 'MISSING_ORIGIN',
      message: 'Origin header required when domain restrictions are enabled'
    };
  }

  try {
    const originUrl = new URL(origin);
    const domain = originUrl.hostname + (originUrl.port ? `:${originUrl.port}` : '');
    
    const isAllowed = CONFIG.ADMIN.ALLOWED_DOMAINS.some(allowedDomain => {
      // Exact match or subdomain match
      return domain === allowedDomain || domain.endsWith(`.${allowedDomain}`);
    });

    if (!isAllowed) {
      return {
        allowed: false,
        error: 'DOMAIN_NOT_ALLOWED',
        message: `Domain ${domain} is not in the allowed list`
      };
    }

    return { allowed: true, domain };
    
  } catch (error) {
    return {
      allowed: false,
      error: 'INVALID_ORIGIN',
      message: 'Invalid origin header format'
    };
  }
}

// Helper function to parse share URL and extract components
function parseShareUrl(shareUrl) {
  try {
    const url = new URL(shareUrl);
    const params = new URLSearchParams(url.search);
    
    const encodedArweaveUrl = params.get('url');
    const encryptionKey = params.get('key');
    const contentType = params.get('type');

    if (!encodedArweaveUrl) {
      throw new Error('Missing URL parameter');
    }

    // Validate base64 before decoding
    try {
      const arweaveUrl = atob(encodedArweaveUrl);
      
      // Validate it's a proper Arweave URL
      if (!arweaveUrl.startsWith('https://arweave.net/') && !arweaveUrl.startsWith('https://ar-io.net/')) {
        throw new Error('Invalid Arweave URL');
      }
      
      return {
        arweaveUrl,
        encryptionKey: encryptionKey ? decodeURIComponent(encryptionKey) : null,
        contentType: contentType ? decodeURIComponent(contentType) : null
      };
      
    } catch (decodeError) {
      throw new Error('Invalid URL encoding');
    }
    
  } catch (error) {
    throw new Error('Invalid share URL format');
  }
}

// Function handler with timeout delegation and decryption
exports.handler = async (event, context) => {
  const startTime = Date.now();
  
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Call, X-Original-Host',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers,
      body: ''
    };
  }

  // Check domain restrictions for all requests (unless using Cloudflare protection)
  if (CONFIG.ADMIN.DOMAIN_RESTRICTION_ENABLED) {
    const domainCheck = checkDomainAccess(event.headers);
    if (!domainCheck.allowed) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'ACCESS_DENIED',
          message: 'Access not allowed from this domain',
          duration: Date.now() - startTime
        })
      };
    }
  }

  // Handle GET requests for decryption and info
  if (event.httpMethod === 'GET') {
    // Check if this is a request for API info/health check
    if (!event.queryStringParameters?.url) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          name: 'Thyra API',
          version: '1.0.0',
          description: 'Encrypted file storage and sharing API',
          endpoints: {
            'POST /': 'Upload and encrypt files',
            'GET /?url=<shareUrl>': 'Decrypt and retrieve files',
            'GET /': 'API information (this endpoint)'
          },
          limits: {
            maxUploadSize: `${Math.floor(CONFIG.MAX_ALREADY_ENCRYPTED / 1024)}KB`,
            maxEncryptionSize: `${Math.floor(CONFIG.MAX_RAW_FOR_ENCRYPTION / 1024)}KB`,
            maxDecryptionSize: `${Math.floor(CONFIG.MAX_DECRYPTION_SIZE / 1024)}KB`
          },
          features: {
            encryption: 'AES-256-GCM',
            storage: 'Arweave (permanent)',
            delegation: 'Timeout protection enabled',
            domainRestriction: CONFIG.ADMIN.DOMAIN_RESTRICTION_ENABLED,
            decryptionEndpoint: CONFIG.ADMIN.DECRYPTION_ENABLED
          },
          status: 'operational',
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime
        })
      };
    }

    // Handle decryption request
    if (!CONFIG.ADMIN.DECRYPTION_ENABLED) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'ENDPOINT_DISABLED',
          message: 'Service temporarily unavailable',
          duration: Date.now() - startTime
        })
      };
    }

    // Handle decryption request
    try {
      const shareUrl = event.queryStringParameters?.url;
      
      if (!shareUrl) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            success: false,
            error: 'MISSING_PARAMETER',
            message: 'Required parameter missing',
            duration: Date.now() - startTime
          })
        };
      }

      const uploader = new MinimalThyraUploader();
      
      // Parse the share URL
      const { arweaveUrl, encryptionKey, contentType } = parseShareUrl(shareUrl);
      
      if (!encryptionKey) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            success: false,
            error: 'CONTENT_NOT_ENCRYPTED',
            message: 'Content is not encrypted',
            duration: Date.now() - startTime
          })
        };
      }

      // Fetch content from Arweave with size validation
      const arweaveResponse = await fetch(arweaveUrl);
      if (!arweaveResponse.ok) {
        throw new Error('Failed to fetch content');
      }

      // Check content size before processing
      const contentLength = arweaveResponse.headers.get('content-length');
      if (contentLength && parseInt(contentLength) > CONFIG.MAX_DECRYPTION_SIZE) {
        throw new Error('Content too large for decryption');
      }

      const encryptedContent = await arweaveResponse.text();
      
      // Additional size check after fetch
      if (encryptedContent.length > CONFIG.MAX_DECRYPTION_SIZE) {
        throw new Error('Content too large for decryption');
      }
      
      // Parse encrypted JSON
      let encryptedData;
      try {
        encryptedData = JSON.parse(encryptedContent);
        
        // Validate encrypted data structure
        if (!encryptedData.algorithm || !encryptedData.encrypted || !encryptedData.iv || !encryptedData.authTag) {
          throw new Error('Invalid encrypted format');
        }
      } catch (error) {
        throw new Error('Invalid content format');
      }

      // Validate encryption key
      const keyBuffer = uploader.validateEncryptionKey(encryptionKey);
      if (!keyBuffer) {
        throw new Error('Invalid encryption key');
      }

      // Decrypt the content
      const decryptedBuffer = await uploader.decryptContent(encryptedData, keyBuffer);
      
      // Determine how to return the content
      const isText = contentType?.startsWith('text/') || 
                    contentType?.includes('json') || 
                    uploader.isTextContent(decryptedBuffer.slice(0, 100));

      if (isText) {
        // Return text content as JSON
        return {
          statusCode: 200,
          headers: {
            ...headers,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            success: true,
            content: decryptedBuffer.toString('utf8'),
            contentType: contentType || 'text/plain',
            size: decryptedBuffer.length,
            duration: Date.now() - startTime
          })
        };
      } else {
        // Return binary content as base64
        return {
          statusCode: 200,
          headers: {
            ...headers,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            success: true,
            content: decryptedBuffer.toString('base64'),
            isBase64: true,
            contentType: contentType || 'application/octet-stream',
            size: decryptedBuffer.length,
            duration: Date.now() - startTime
          })
        };
      }

    } catch (error) {
      safeError('Decryption error:', error);
      
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'PROCESSING_FAILED',
          message: 'Unable to process request',
          duration: Date.now() - startTime
        })
      };
    }
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'METHOD_NOT_ALLOWED',
        message: 'Only POST and GET methods allowed',
        duration: Date.now() - startTime
      })
    };
  }

  try {
    const uploader = new MinimalThyraUploader();
    const timestamp = Date.now();
    
    let requestData;
    let contentBuffer;
    let originalFilename = 'upload';
    let detectedContentType = 'application/octet-stream';
    let isInternalCall = false;

    // Check if this is an internal delegation call
    isInternalCall = event.headers['x-internal-call'] === 'true' || 
                     event.queryStringParameters?.internal === 'true';

    // Prevent infinite delegation loops
    const delegationDepth = parseInt(event.headers['x-delegation-depth'] || '0');
    if (delegationDepth >= 1) {
      safeLog('Maximum delegation depth reached, processing in current function');
      isInternalCall = false; // Force processing in current function
    }

    if (isInternalCall) {
      // Handle internal delegation call - data is already processed
      try {
        const internalData = JSON.parse(event.body);
        
        // Handle both base64 and array formats for backward compatibility
        if (internalData.processedContent) {
          contentBuffer = Buffer.from(internalData.processedContent, 'base64');
        } else if (internalData.contentBuffer) {
          contentBuffer = Buffer.from(internalData.contentBuffer);
        } else {
          throw new Error('Missing content data');
        }
        
        originalFilename = internalData.originalFilename || 'upload';
        detectedContentType = internalData.detectedContentType || 'application/octet-stream';
        
        requestData = {
          encrypt: internalData.encrypt,
          customKey: internalData.customKey,
          note: internalData.note,
          id: internalData.id,
          includeWallet: internalData.includeWallet,
          formContentType: internalData.formContentType
        };

        safeLog(`Internal call processing: ${Math.round(contentBuffer.length/1024)}KB file`);
        
      } catch (parseError) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            success: false,
            error: 'INVALID_REQUEST',
            message: 'Invalid internal request format',
            duration: Date.now() - startTime
          })
        };
      }

    } else {
      // Handle normal request
      const contentType = event.headers['content-type'] || '';
      
      if (contentType.includes('multipart/form-data')) {
        // Handle file upload - load parser only when needed
        let multipart;
        try {
          multipart = require('lambda-multipart-parser');
        } catch (err) {
          return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
              success: false,
              error: 'MULTIPART_NOT_AVAILABLE',
              message: 'File upload functionality not available. Install lambda-multipart-parser.',
              duration: Date.now() - startTime
            })
          };
        }

        try {
          const result = await multipart.parse(event, {
            maxFileSize: CONFIG.MAX_ALREADY_ENCRYPTED, // Reject large files early
            maxFiles: 1 // Only allow single file upload
          });
          
          if (!result.files || result.files.length === 0) {
            return {
              statusCode: 400,
              headers,
              body: JSON.stringify({
                success: false,
                error: 'NO_FILE_PROVIDED',
                message: 'No file provided in multipart upload',
                duration: Date.now() - startTime
              })
            };
          }

          const file = result.files[0];
          contentBuffer = Buffer.from(file.content);
          originalFilename = file.filename || 'upload';
          
          // Cache content type detection result
          detectedContentType = uploader.detectContentType(contentBuffer, originalFilename, file.contentType);

          // Extract form parameters
          requestData = {
            encrypt: result.encrypt === 'true' || result.encrypt === true,
            customKey: result.customKey || null,
            note: result.note || null,
            id: result.id || null,
            includeWallet: result.includeWallet === 'true' || result.includeWallet === true,
            formContentType: result.contentType || detectedContentType
          };

        } catch (parseError) {
          // Handle multipart parsing errors including size limits
          const errorMessage = parseError.message.toLowerCase();
          
          if (errorMessage.includes('file too large') || errorMessage.includes('maxfilesize')) {
            return {
              statusCode: 413,
              headers,
              body: JSON.stringify({
                success: false,
                error: 'FILE_TOO_LARGE',
                message: 'File size exceeds limit',
                duration: Date.now() - startTime
              })
            };
          }
          
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              success: false,
              error: 'INVALID_UPLOAD',
              message: 'Failed to process file upload',
              duration: Date.now() - startTime
            })
          };
        }

      } else {
        // Handle JSON request
        try {
          requestData = JSON.parse(event.body || '{}');
        } catch (err) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              success: false,
              error: 'INVALID_JSON',
              message: 'Invalid JSON in request body',
              duration: Date.now() - startTime
            })
          };
        }

        const { content, isBase64 = false } = requestData;

        if (!content && content !== "") {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              success: false,
              error: 'MISSING_CONTENT',
              message: 'Content is required',
              duration: Date.now() - startTime
            })
          };
        }

        // Convert content to buffer
        try {
          contentBuffer = isBase64 ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
          // Cache content type detection result
          detectedContentType = uploader.detectContentType(contentBuffer);
        } catch (err) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              success: false,
              error: 'INVALID_CONTENT',
              message: 'Invalid content format',
              duration: Date.now() - startTime
            })
          };
        }
      }

      // Check if we should delegate to a fresh function (timeout protection)
      const uploadDuration = Date.now() - startTime;
      const shouldDelegate = uploadDuration > CONFIG.TIMEOUT_THRESHOLD && contentBuffer.length > 10 * 1024; // Only for files > 10KB

      if (shouldDelegate) {
        safeLog(`Processing took ${uploadDuration}ms, delegating to fresh function for ${Math.round(contentBuffer.length/1024)}KB file`);
  
        try {
          return await delegateToFreshFunction({
            contentBuffer: Array.from(contentBuffer),
            originalFilename,
            detectedContentType,
            ...requestData
          }, event.headers, startTime, delegationDepth);
        } catch (delegationError) {
          safeError('Delegation failed, continuing with current function:', delegationError);
          // and now fall through to do the upload in this function
        }
      }
    }

    // Continue with normal processing
    const {
      encrypt = true,
      customKey = null,
      note = null,
      id = null,
      includeWallet = false,
      formContentType = null
    } = requestData;

    // Use the appropriate content type
    const finalContentType = formContentType || detectedContentType;

    const uploadId = id || crypto.randomUUID();

    // Validate size with limits
    const sizeInfo = uploader.validateSize(contentBuffer, encrypt);

    let finalContent, encryptionKey, shareUrl;

    if (encrypt) {
      // Validate custom key first, then generate or use it
      try {
        encryptionKey = customKey 
          ? uploader.validateEncryptionKey(customKey)
          : await uploader.generateEncryptionKey();
      } catch (keyError) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({
            success: false,
            error: 'INVALID_KEY_LENGTH',
            message: keyError.message,
            duration: Date.now() - startTime
          })
        };
      }

      // Encrypt content
      const encryptedData = await uploader.encryptContent(contentBuffer, encryptionKey);
      finalContent = Buffer.from(JSON.stringify(encryptedData));

      if (finalContent.length > CONFIG.MAX_SIZE_BYTES) {
        throw new Error(`Encrypted content too large: ${finalContent.length} bytes`);
      }

    } else {
      finalContent = contentBuffer;
      
      if (customKey) {
        try {
          encryptionKey = uploader.validateEncryptionKey(customKey);
        } catch (keyError) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({
              success: false,
              error: 'INVALID_KEY_LENGTH',
              message: keyError.message,
              duration: Date.now() - startTime
            })
          };
        }
      }
    }

    // Upload to Arweave
    const uploadResult = await uploader.uploadToArweave(finalContent, [
      ...(note ? [{ name: 'Note', value: note }] : []),
      ...(originalFilename !== 'upload' ? [{ name: 'Original-Filename', value: originalFilename }] : []),
      { name: 'Content-Type-Hint', value: finalContentType },
      { name: 'Encrypted', value: encrypt.toString() },
      { name: 'Upload-ID', value: uploadId }
    ]);

    const arweaveId = uploadResult.id;
    const arweaveUrl = `https://arweave.net/${arweaveId}`;

    // Create share URL
    if (encryptionKey) {
      const protocol = event.headers['x-forwarded-proto'] || 'https';
      const host = event.headers.host;
      const baseUrl = `${protocol}://${host}`;
      shareUrl = uploader.createShareUrl(arweaveId, encryptionKey, baseUrl, finalContentType);
    } else if (!encrypt) {
      const protocol = event.headers['x-forwarded-proto'] || 'https';
      const host = event.headers.host;
      const baseUrl = `${protocol}://${host}`;
      shareUrl = `${baseUrl}/s/?url=${btoa(arweaveUrl)}${finalContentType ? `&type=${encodeURIComponent(finalContentType)}` : ''}`;
    }

    const response = {
      success: true,
      id: uploadId,
      arweaveId,
      url: arweaveUrl,
      encrypted: encrypt,
      size: sizeInfo.baseSize,
      contentType: finalContentType,
      timestamp,
      duration: Date.now() - startTime
    };

    // Add conditional fields
    if (shareUrl) response.shareUrl = shareUrl;
    if (note) response.note = note;
    if (originalFilename !== 'upload') response.filename = originalFilename;
    if (includeWallet) response.wallet = uploadResult.wallet;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(response)
    };

  } catch (error) {
    safeError('Upload error:', error);

    let errorCode = 'UPLOAD_FAILED';
    let statusCode = 500;

    if (error.message.includes('too large for encryption')) {
      errorCode = 'CONTENT_TOO_LARGE_FOR_ENCRYPTION';
      statusCode = 413;
    } else if (error.message.includes('Encrypted content would be too large')) {
      errorCode = 'ENCRYPTED_SIZE_TOO_LARGE';
      statusCode = 413;
    } else if (error.message.includes('Content too large')) {
      errorCode = 'CONTENT_TOO_LARGE';
      statusCode = 413;
    } else if (error.message.includes('Invalid content')) {
      errorCode = 'INVALID_CONTENT';
      statusCode = 400;
    } else if (error.message.includes('Invalid key length')) {
      errorCode = 'INVALID_KEY_LENGTH';
      statusCode = 400;
    }

    return {
      statusCode,
      headers,
      body: JSON.stringify({
        success: false,
        error: errorCode,
        message: error.message,
        duration: Date.now() - startTime
      })
    };
  }
};

// Helper function to delegate to a fresh function instance
async function delegateToFreshFunction(processedData, originalHeaders, originalStartTime, currentDepth = 0) {
  const protocol = originalHeaders['x-forwarded-proto'] || 'https';
  const host = originalHeaders['host'];
  const baseUrl = `${protocol}://${host}`;
  
  // Extract the function path from the request
  const functionPath = '/.netlify/functions/arload';
  const delegationUrl = `${baseUrl}${functionPath}?internal=true`;

  try {
    const response = await fetch(delegationUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Call': 'true',
        'X-Delegation-Depth': (currentDepth + 1).toString(),
        'X-Original-Host': originalHeaders['host'],
        'User-Agent': 'Thyra-Internal-Delegation/1.0'
      },
      body: JSON.stringify(processedData),
      timeout: 9000 // 9 second timeout for the delegated call
    });

    if (!response.ok) {
      throw new Error(`Delegation failed with status ${response.status}`);
    }

    const responseData = await response.json();
    
    // Add delegation info to response
    responseData.delegated = true;
    responseData.originalDuration = Date.now() - originalStartTime;

    return {
      statusCode: response.status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Call, X-Original-Host',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
      },
      body: JSON.stringify(responseData)
    };

  } catch (fetchError) {
    throw new Error('Delegation request failed');
  }
}
