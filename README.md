# arload a storage helper for Thyra 
# Thyra Storage CLI

Upload files and messages to Arweave with optional encryption.

## Requirements

- Node.js 18.0.0 or higher
- Linux x64 system

## Installation

1. Download the latest release: `thyra-cli-v1.0.0.tar.gz`
2. Extract the package:
   ```bash
   tar -xzf thyra-cli-v1.0.0.tar.gz
   ```
3. Run the CLI:
   ```bash
   ./thyra --help
   ```

## Usage

### Start API Server
```bash
# Recommended setup with common port
./thyra server --port 8888 --api-key your-secret-key --db-enabled

# Using environment variables (create .env file first)
./thyra server

# Quick start without authentication
./thyra server --port 8888 --db-enabled
```

Options:
- `--port <port>` - Server port (default: 3000, recommended: 8888)
- `--api-key <key>` - API key for authentication
- `--db-enabled` - Enable database storage
- `--db-path <path>` - Database file path (default: ./thyra-uploads.db)
- `--wallet-path <path>` - Wallet file path (default: ./thyra-wallet.json)
- `--log-level <level>` - Log level (debug, info, warn, error)

### Upload Files
```bash
./thyra upload ./myfile.txt --api-key your-secret-key
```

Options:
- `--server <url>` - Server URL (default: http://localhost:3000)
- `--api-key <key>` - API key for authentication
- `--encryption <type>` - Encryption type (none, random, drive)
- `--note <note>` - Add a note to the upload
- `--id <id>` - Custom upload ID
- `--no-store` - Don't store in database

### Send Messages
```bash
./thyra message "Hello Arweave!" --api-key your-secret-key
```

### List Uploads
```bash
./thyra list --api-key your-secret-key --limit 10
```

### Wallet Management
```bash
./thyra wallet
```

### Interactive Mode
```bash
# Auto-detect running server (recommended)
./thyra interactive --api-key your-secret-key

# Specify server explicitly
./thyra interactive --server http://localhost:8888 --api-key your-secret-key

# Quick start (will auto-detect server on common ports)
./thyra interactive
```

**Tip**: Interactive mode automatically detects servers running on ports 8888, 8080, 3000, and other common development ports.

## Development

### Building from Source

Requirements:
- Node.js 18.0.0+
- npm

Clone and build:
```bash
git clone <repository>
cd thyra-cli
npm install
npm run bundle
```

### Files Structure

- `thyra-r-cli.js` - CLI interface
- `thyra-r.js` - API server
- `package.json` - Dependencies and scripts
- `build.js` - Build script for distribution

### Build Scripts

```bash
npm run bundle      # Create distribution package
npm run dev         # Development mode with auto-reload
npm run link        # Install globally for development
```

## API Endpoints

When running the server, these endpoints are available:

- `POST /api/upload` - Upload files or messages
- `GET /api/wallet/address` - Get wallet address
- `GET /api/uploads` - List uploads (requires API key)
- `GET /api/health` - Health check
- `GET /share/:arweaveId` - Decrypt shared content
- `GET /docs` - API documentation

## Configuration

## Configuration

### Environment Variables

Create a `.env` file in the same directory as your Thyra installation:

```env
# Server Configuration
PORT=8888
API_KEY=your-secret-key

# Database Configuration  
DB_ENABLED=true
DB_PATH=./thyra-uploads.db

# Wallet Configuration
WALLET_PATH=./thyra-wallet.json

# Logging
LOG_LEVEL=info
NODE_ENV=development
```

### Common Ports

Thyra will auto-detect running servers on these common ports:
- **8888** - Default recommended port
- **8080** - Alternative web port
- **3000** - Node.js default
- **3001, 4000, 5000** - Other common development ports

You can specify any port when starting the server:
```bash
./thyra server --port 8888 --api-key your-secret-key --db-enabled
```

### Interactive Mode with Auto-Detection

Interactive mode automatically detects running servers:

```bash
# Auto-detect server and use environment API key
./thyra interactive

# Specify server and API key explicitly  
./thyra interactive --server http://localhost:8888 --api-key your-secret-key

# Use different server
./thyra interactive --server http://localhost:3000
```

**Note**: If your server requires an API key, start interactive mode with `--api-key` to avoid authentication prompts.

### Configuration Priority

Settings are applied in this order (highest to lowest priority):
1. **Command line arguments** (`--port 8888`)
2. **Shell environment variables** (`export API_KEY=mykey`)
3. **`.env` file** (`API_KEY=mykey`)

### Database

When database is enabled, uploads are stored locally in SQLite:
- Upload history and metadata
- Notes and custom IDs
- Share URLs for encrypted content
- Timestamps and file sizes

Database file location: `DB_PATH` (default: `./thyra-uploads.db`)

## Security

- **API Key**: Protects upload endpoints
- **Encryption**: Files encrypted before upload to Arweave
- **Wallet**: Securely generated and stored locally

## Examples

### Basic Usage
```bash
# Start server on recommended port with authentication
./thyra server --port 8888 --api-key mykey123 --db-enabled

# Upload file (in another terminal) - server auto-detected
./thyra upload document.pdf --api-key mykey123

# Or use interactive mode (auto-detects server on port 8888)
./thyra interactive --api-key mykey123

# Send encrypted message
./thyra message "Secret message" --api-key mykey123 --encryption random
```

### Advanced Usage
```bash
# Custom server with all options
./thyra server --port 8080 --api-key mykey123 --db-enabled --log-level debug

# Upload to specific server
./thyra upload file.txt --server http://localhost:8080 --api-key mykey123

# List recent uploads
./thyra list --api-key mykey123 --limit 20

# Interactive mode with specific server
./thyra interactive --server http://localhost:8080 --api-key mykey123
```

## Troubleshooting

### Common Issues

**"API Key required" error**
- Make sure you're using the same API key for server and client
- Use `--api-key` flag or set `API_KEY` environment variable

**"Module not found" error**
- Ensure Node.js 18+ is installed: `node --version`
- Extract the full package, don't copy individual files

**"Permission denied" error**
- Make sure the `thyra` script is executable: `chmod +x thyra`

### Getting Help

Check server status:
```bash
./thyra config           # Show configuration
curl http://localhost:3000/api/health  # Health check
```

View logs with debug level:
```bash
./thyra server --log-level debug
```

## License

MIT License
