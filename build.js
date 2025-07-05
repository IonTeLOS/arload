// build.js - Create distribution
import { execSync } from 'child_process';
import { mkdirSync, writeFileSync } from 'fs';

function build() {
  try {
    console.log('🔧 Creating reliable distribution...');

    // Clean and create dist directory
    execSync('rm -rf dist', { stdio: 'inherit' });
    mkdirSync('dist', { recursive: true });

    // Copy only the files we need (exclude dist to avoid recursion)
    const filesToCopy = [
      'thyra-r-cli.js',
      'thyra-r.js',
      'package.json',
      '.env'
    ];

    mkdirSync('dist/thyra-cli-standalone', { recursive: true });

    filesToCopy.forEach(file => {
      try {
        execSync(`cp ${file} dist/thyra-cli-standalone/`, { stdio: 'inherit' });
      } catch (e) {
        console.log(`Skipping ${file} (not found)`);
      }
    });

    // Install dependencies in the standalone directory
    execSync('cd dist/thyra-cli-standalone && npm install --production', { stdio: 'inherit' });


    // Create launcher script with warning suppression
    const launcher = `#!/bin/bash
# Thyra CLI Launcher
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR/thyra-cli-standalone"
export NODE_NO_WARNINGS=1
node --no-warnings thyra-r-cli.js "$@"
`;

    writeFileSync('dist/thyra', launcher);
    execSync('chmod +x dist/thyra');

    // Create archive
    execSync('cd dist && tar -czf thyra-cli-v1.0.0.tar.gz thyra thyra-cli-standalone', { stdio: 'inherit' });

    console.log('✅ Distribution created successfully!');
    console.log('📦 File: dist/thyra-cli-v1.0.0.tar.gz');
    console.log('📦 Test: cd dist && tar -xzf thyra-cli-v1.0.0.tar.gz && ./thyra --help');

  } catch (error) {
    console.error('❌ Build failed:', error);
    process.exit(1);
  }
}

build();
