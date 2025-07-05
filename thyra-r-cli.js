#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const program = new Command();

// CLI Configuration
program
  .name('thyra')
  .description('Thyra Storage CLI - Upload files and messages to Arweave')
  .version('1.0.0');

// Server command
program
  .command('server')
  .description('Start the Thyra API server')
  .option('-p, --port <port>', 'Server port', process.env.PORT || '3000')
  .option('-k, --api-key <key>', 'API key for authentication', process.env.API_KEY)
  .option('--db-enabled', 'Enable database storage', process.env.DB_ENABLED === 'true')
  .option('--db-path <path>', 'Database file path', process.env.DB_PATH || './thyra-uploads.db')
  .option('--wallet-path <path>', 'Wallet file path', process.env.WALLET_PATH || './thyra-wallet.json')
  .option('--log-level <level>', 'Log level (debug, info, warn, error)', process.env.LOG_LEVEL || 'info')
  .action(async (options) => {
    console.log(chalk.blue('🚀 Starting Thyra API Server...'));

    // Set environment variables from CLI options BEFORE importing server
    if (options.port) process.env.PORT = options.port;
    if (options.apiKey) process.env.API_KEY = options.apiKey;
    if (options.dbEnabled) process.env.DB_ENABLED = 'true';
    if (options.dbPath) process.env.DB_PATH = options.dbPath;
    if (options.walletPath) process.env.WALLET_PATH = options.walletPath;
    if (options.logLevel) process.env.LOG_LEVEL = options.logLevel;

    console.log(chalk.gray('Configuration:'));
    console.log(chalk.gray(`  Port: ${process.env.PORT}`));
    console.log(chalk.gray(`  API Key: ${process.env.API_KEY ? '***' + process.env.API_KEY.slice(-3) : 'None'}`));
    console.log(chalk.gray(`  Database: ${process.env.DB_ENABLED === 'true' ? 'Enabled' : 'Disabled'}`));
    console.log(chalk.gray(`  Wallet: ${process.env.WALLET_PATH}`));
    console.log('');

    try {
      // DYNAMIC IMPORT after setting environment variables
      const { start } = await import('./thyra-r.js');
      await start();
    } catch (error) {
      console.error(chalk.red('❌ Failed to start server:'), error.message);
      console.error(chalk.red('❌ Error details:'), error.stack);
      process.exit(1);
    }
  });

// Upload command
program
  .command('upload <file>')
  .description('Upload a file to Arweave')
  .option('-s, --server <url>', 'Server URL', 'http://localhost:3000')
  .option('-k, --api-key <key>', 'API key for authentication')
  .option('-e, --encryption <type>', 'Encryption type (none, random, drive)', 'random')
  .option('-n, --note <note>', 'Add a note to the upload')
  .option('-i, --id <id>', 'Custom upload ID')
  .option('--no-store', 'Don\'t store in database')
  .action(async (file, options) => {
    try {
      console.log(chalk.blue('📤 Uploading file:'), file);

      if (!fs.existsSync(file)) {
        console.error(chalk.red('❌ File not found:'), file);
        process.exit(1);
      }

      const FormData = (await import('form-data')).default;
      const fetch = (await import('node-fetch')).default;

      const form = new FormData();
      form.append('file', fs.createReadStream(file));

      if (options.encryption) form.append('encryption', options.encryption);
      if (options.note) form.append('note', options.note);
      if (options.id) form.append('id', options.id);
      if (options.noStore) form.append('store', 'false');

      const headers = {};
      if (options.apiKey) {
        headers['X-API-Key'] = options.apiKey;
      }

      const response = await fetch(`${options.server}/api/upload`, {
        method: 'POST',
        body: form,
        headers
      });

      const result = await response.json();

      if (result.success) {
        console.log(chalk.green('✅ Upload successful!'));
        console.log(chalk.yellow('📄 ID:'), result.id);
        console.log(chalk.yellow('🔗 URL:'), result.url);
        if (result.shareUrl) {
          console.log(chalk.yellow('🔐 Share URL:'), result.shareUrl);
        }
        console.log(chalk.yellow('📊 Size:'), result.size, 'bytes');
        console.log(chalk.yellow('🔒 Encrypted:'), result.encrypted ? 'Yes' : 'No');
      } else {
        console.error(chalk.red('❌ Upload failed:'), result.message);
        process.exit(1);
      }

    } catch (error) {
      console.error(chalk.red('❌ Upload error:'), error.message);
      process.exit(1);
    }
  });

// Message command
program
  .command('message <text>')
  .description('Upload a text message to Arweave')
  .option('-s, --server <url>', 'Server URL', 'http://localhost:3000')
  .option('-k, --api-key <key>', 'API key for authentication')
  .option('-e, --encryption <type>', 'Encryption type (none, random, drive)', 'random')
  .option('-n, --note <note>', 'Add a note to the upload')
  .option('-i, --id <id>', 'Custom upload ID')
  .option('--no-store', 'Don\'t store in database')
  .action(async (text, options) => {
    try {
      console.log(chalk.blue('📤 Uploading message...'));

      const fetch = (await import('node-fetch')).default;

      const payload = {
        message: text,
        encryption: options.encryption
      };

      if (options.note) payload.note = options.note;
      if (options.id) payload.id = options.id;
      if (options.noStore) payload.store = false;

      const headers = {
        'Content-Type': 'application/json'
      };

      if (options.apiKey) {
        headers['X-API-Key'] = options.apiKey;
      }

      const response = await fetch(`${options.server}/api/upload`, {
        method: 'POST',
        body: JSON.stringify(payload),
        headers
      });

      const result = await response.json();

      if (result.success) {
        console.log(chalk.green('✅ Message uploaded!'));
        console.log(chalk.yellow('📄 ID:'), result.id);
        console.log(chalk.yellow('🔗 URL:'), result.url);
        if (result.shareUrl) {
          console.log(chalk.yellow('🔐 Share URL:'), result.shareUrl);
        }
        console.log(chalk.yellow('📊 Size:'), result.size, 'bytes');
        console.log(chalk.yellow('🔒 Encrypted:'), result.encrypted ? 'Yes' : 'No');
      } else {
        console.error(chalk.red('❌ Upload failed:'), result.message);
        process.exit(1);
      }

    } catch (error) {
      console.error(chalk.red('❌ Upload error:'), error.message);
      process.exit(1);
    }
  });

// List uploads command
program
  .command('list')
  .description('List recent uploads')
  .option('-s, --server <url>', 'Server URL', 'http://localhost:3000')
  .option('-k, --api-key <key>', 'API key for authentication')
  .option('-l, --limit <number>', 'Limit number of results', '10')
  .option('--since <timestamp>', 'Show uploads since timestamp')
  .action(async (options) => {
    try {
      console.log(chalk.blue('📋 Fetching uploads...'));

      const fetch = (await import('node-fetch')).default;

      const params = new URLSearchParams();
      if (options.limit) params.append('limit', options.limit);
      if (options.since) params.append('since', options.since);

      const headers = {};
      if (options.apiKey) {
        headers['X-API-Key'] = options.apiKey;
      }

      const response = await fetch(`${options.server}/api/uploads?${params}`, {
        headers
      });

      const result = await response.json();

      if (result.success) {
        if (result.uploads.length === 0) {
          console.log(chalk.yellow('📭 No uploads found'));
          return;
        }

        console.log(chalk.green(`📋 Found ${result.uploads.length} uploads:`));
        console.log('');

        result.uploads.forEach((upload, index) => {
          console.log(chalk.cyan(`${index + 1}. ${upload.id}`));
          console.log(chalk.gray(`   URL: ${upload.url}`));
          console.log(chalk.gray(`   Size: ${upload.size} bytes`));
          console.log(chalk.gray(`   Encrypted: ${upload.encrypted ? 'Yes' : 'No'}`));
          console.log(chalk.gray(`   Created: ${new Date(upload.timestamp).toLocaleString()}`));
          if (upload.note) {
            console.log(chalk.gray(`   Note: ${upload.note}`));
          }
          if (upload.share_url) {
            console.log(chalk.gray(`   Share: ${upload.share_url}`));
          }
          console.log('');
        });
      } else {
        console.error(chalk.red('❌ Failed to fetch uploads:'), result.message);
        process.exit(1);
      }

    } catch (error) {
      console.error(chalk.red('❌ List error:'), error.message);
      process.exit(1);
    }
  });

// Wallet commands
program
  .command('wallet')
  .description('Wallet management commands')
  .option('-s, --server <url>', 'Server URL', 'http://localhost:3000')
  .option('-k, --api-key <key>', 'API key for authentication')
  .action(async (options) => {
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          'Show wallet address',
          'Export wallet',
          'Check wallet balance (view only)'
        ]
      }
    ]);

    try {
      const fetch = (await import('node-fetch')).default;

      const headers = {};
      if (options.apiKey) {
        headers['X-API-Key'] = options.apiKey;
      }

      if (answers.action === 'Show wallet address') {
        const response = await fetch(`${options.server}/api/wallet/address`, { headers });
        const result = await response.json();

        if (result.success) {
          console.log(chalk.green('💼 Wallet Address:'), result.address);
          console.log(chalk.gray('🔗 View on ArScan:'), `https://arscan.io/address/${result.address}`);
        } else {
          console.error(chalk.red('❌ Error:'), result.message);
        }
      } else if (answers.action === 'Export wallet') {
        const exportAnswers = await inquirer.prompt([
          {
            type: 'input',
            name: 'path',
            message: 'Export path (default: ./thyra-wallet-backup.json):',
            default: './thyra-wallet-backup.json'
          }
        ]);

        const response = await fetch(`${options.server}/api/wallet/export`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...headers
          },
          body: JSON.stringify({ path: exportAnswers.path })
        });

        const result = await response.json();

        if (result.success) {
          console.log(chalk.green('💾 Wallet exported to:'), result.walletPath);
          console.log(chalk.yellow('⚠️  Keep this file secure!'));
        } else {
          console.error(chalk.red('❌ Export failed:'), result.message);
        }
      }
    } catch (error) {
      console.error(chalk.red('❌ Wallet error:'), error.message);
    }
  });

// Interactive mode
program
  .command('config')
  .description('Show current configuration')
  .option('-s, --server <url>', 'Server URL', 'http://localhost:3000')
  .option('-k, --api-key <key>', 'API key for authentication')
  .action(async (options) => {
    console.log(chalk.blue('⚙️  Current Configuration:'));
    console.log('');

    const envVars = [
      'PORT', 'API_KEY', 'DB_ENABLED', 'DB_PATH',
      'WALLET_PATH', 'LOG_LEVEL', 'NODE_ENV'
    ];

    envVars.forEach(envVar => {
      const value = process.env[envVar];
      if (value) {
        const displayValue = envVar === 'API_KEY' ? '***' + value.slice(-3) : value;
        console.log(chalk.yellow(`${envVar}:`), displayValue);
      } else {
        console.log(chalk.gray(`${envVar}:`), 'Not set');
      }
    });

    // Also check server configuration if possible
    if (options.server) {
      console.log('');
      console.log(chalk.blue('🌐 Server Configuration:'));

      try {
        const fetch = (await import('node-fetch')).default;

        const headers = {};
        if (options.apiKey) {
          headers['X-API-Key'] = options.apiKey;
        }

        const response = await fetch(`${options.server}/api/health`, { headers });
        const result = await response.json();

        if (result.success) {
          console.log(chalk.green('📊 Status:'), result.status);
          console.log(chalk.green('⏱️  Uptime:'), `${result.uptime}s`);
          console.log(chalk.green('🔧 Initialized:'), result.initialized ? 'Yes' : 'No');
          console.log(chalk.green('💾 Database:'), result.database ? 'Enabled' : 'Disabled');
          console.log(chalk.green('🌍 Environment:'), result.environment);
        } else {
          console.log(chalk.yellow('⚠️  Server info unavailable'));
        }
      } catch (error) {
        console.log(chalk.gray('📡 Server:'), 'Not reachable');
      }
    }
  });

// Interactive mode - DETECT running server automatically
program
  .command('interactive')
  .alias('i')
  .description('Interactive mode')
  .option('-s, --server <url>', 'Server URL (will auto-detect if not specified)')
  .option('-k, --api-key <key>', 'API key for authentication')
  .action(async (options) => {
    console.log(chalk.blue('🎯 Welcome to Thyra Interactive Mode!'));
    console.log('');

    // Auto-detect running server if not specified
    let serverUrl = options.server;
    let detectedPort = null;

    if (!serverUrl) {
      console.log(chalk.yellow('🔍 Auto-detecting running server...'));

      // Try common ports based on environment
      const portsToTry = [
        process.env.PORT,
        '8888', '8080', '3000', '3001', '4000', '5000'
      ].filter(Boolean);

      for (const port of portsToTry) {
        try {
          const fetch = (await import('node-fetch')).default;
          const testUrl = `http://localhost:${port}`;
          const response = await fetch(`${testUrl}/api/health`, {
            timeout: 1000,
            signal: AbortSignal.timeout(1000)
          });

          if (response.ok) {
            serverUrl = testUrl;
            detectedPort = port;
            console.log(chalk.green(`✅ Found server at port ${port}`));
            break;
          }
        } catch (e) {
          // Port not available, continue
        }
      }

      if (!serverUrl) {
        console.log(chalk.yellow('⚠️  No running server detected, using default localhost:3000'));
        serverUrl = 'http://localhost:3000';
      }
    }

    // Show current configuration
    console.log(chalk.blue('⚙️  Current Configuration:'));
    console.log(chalk.gray(`🌐 Server URL: ${serverUrl}${detectedPort ? ' (auto-detected)' : ''}`));
    console.log(chalk.gray(`🔑 CLI API Key: ${options.apiKey ? '***' + options.apiKey.slice(-3) : 'None'}`));

    // Show environment variables
    const envVars = [
      { name: 'PORT', desc: 'Server Port' },
      { name: 'API_KEY', desc: 'API Key' },
      { name: 'DB_ENABLED', desc: 'Database' },
      { name: 'DB_PATH', desc: 'Database Path' },
      { name: 'WALLET_PATH', desc: 'Wallet Path' },
      { name: 'LOG_LEVEL', desc: 'Log Level' }
    ];

    console.log(chalk.gray('📋 Environment:'));
    envVars.forEach(envVar => {
      const value = process.env[envVar.name];
      if (value) {
        const displayValue = envVar.name === 'API_KEY' ? '***' + value.slice(-3) : value;
        console.log(chalk.gray(`   ${envVar.desc}: ${displayValue}`));
      } else {
        console.log(chalk.gray(`   ${envVar.desc}: Not set`));
      }
    });
    console.log('');

    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'What would you like to do?',
        choices: [
          'Start API server',
          'Upload a file',
          'Send a message',
          'List uploads',
          'Manage wallet',
          'Show configuration',
          'Exit'
        ]
      }
    ]);

    // Handle the selected action
    switch (answers.action) {
      case 'Start API server':
        // Get server options interactively
        const serverAnswers = await inquirer.prompt([
          {
            type: 'input',
            name: 'port',
            message: 'Port:',
            default: process.env.PORT || detectedPort || '3000'
          },
          {
            type: 'input',
            name: 'apiKey',
            message: 'API Key (optional):',
            default: process.env.API_KEY || ''
          },
          {
            type: 'confirm',
            name: 'dbEnabled',
            message: 'Enable database?',
            default: process.env.DB_ENABLED === 'true'
          }
        ]);

        const serverArgs = ['node', 'thyra', 'server'];
        if (serverAnswers.port) serverArgs.push('--port', serverAnswers.port);
        if (serverAnswers.apiKey) serverArgs.push('--api-key', serverAnswers.apiKey);
        if (serverAnswers.dbEnabled) serverArgs.push('--db-enabled');

        await program.parseAsync(serverArgs);
        break;

      case 'Upload a file':
        const fileAnswers = await inquirer.prompt([
          {
            type: 'input',
            name: 'file',
            message: 'File path:'
          },
          {
            type: 'input',
            name: 'apiKey',
            message: 'API Key (if required):',
            default: options.apiKey || process.env.API_KEY || ''
          }
        ]);

        const uploadArgs = ['node', 'thyra', 'upload', fileAnswers.file];
        uploadArgs.push('--server', serverUrl);  // Use detected server
        if (fileAnswers.apiKey) uploadArgs.push('--api-key', fileAnswers.apiKey);

        await program.parseAsync(uploadArgs);
        break;

      case 'Send a message':
        const messageAnswers = await inquirer.prompt([
          {
            type: 'input',
            name: 'message',
            message: 'Message text:'
          },
          {
            type: 'input',
            name: 'apiKey',
            message: 'API Key (if required):',
            default: options.apiKey || process.env.API_KEY || ''
          }
        ]);

        const messageArgs = ['node', 'thyra', 'message', messageAnswers.message];
        messageArgs.push('--server', serverUrl);  // Use detected server
        if (messageAnswers.apiKey) messageArgs.push('--api-key', messageAnswers.apiKey);

        await program.parseAsync(messageArgs);
        break;

      case 'List uploads':
        const listAnswers = await inquirer.prompt([
          {
            type: 'input',
            name: 'apiKey',
            message: 'API Key (if required):',
            default: options.apiKey || process.env.API_KEY || ''
          }
        ]);

        const listArgs = ['node', 'thyra', 'list'];
        listArgs.push('--server', serverUrl);  // Use detected server
        if (listAnswers.apiKey) listArgs.push('--api-key', listAnswers.apiKey);

        await program.parseAsync(listArgs);
        break;

      case 'Manage wallet':
        const walletArgs = ['node', 'thyra', 'wallet'];
        walletArgs.push('--server', serverUrl);  // Use detected server
        if (options.apiKey || process.env.API_KEY) {
          walletArgs.push('--api-key', options.apiKey || process.env.API_KEY);
        }

        await program.parseAsync(walletArgs);
        break;

      case 'Show configuration':
        const configArgs = ['node', 'thyra', 'config'];
        configArgs.push('--server', serverUrl);  // Use detected server
        if (options.apiKey || process.env.API_KEY) {
          configArgs.push('--api-key', options.apiKey || process.env.API_KEY);
        }

        await program.parseAsync(configArgs);
        break;

      case 'Exit':
        console.log(chalk.gray('👋 Goodbye!'));
        process.exit(0);
    }
  });

// Handle unknown commands
program.on('command:*', () => {
  console.error(chalk.red('❌ Unknown command:'), program.args.join(' '));
  console.log(chalk.gray('Run'), chalk.yellow('thyra --help'), chalk.gray('for available commands'));
  process.exit(1);
});

// Show help by default
if (process.argv.length === 2) {
  program.help();
}

program.parse(process.argv);
