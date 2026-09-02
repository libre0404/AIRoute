#!/bin/bash
set -e

echo "=== Installing dependencies ==="
npm ci --no-audit --no-fund --legacy-peer-deps --ignore-scripts

echo "=== Rebuilding better-sqlite3 from source ==="
cd node_modules/better-sqlite3

# Install node-gyp if not present
if ! command -v node-gyp &> /dev/null; then
  npm install node-gyp --no-save
fi

# Force rebuild from source
node-gyp rebuild --verbose

cd ../..

echo "=== Running smoke test ==="
node -e "
const Database = require('better-sqlite3');
const db = new Database(':memory:');
db.exec('CREATE TABLE smoke_test (id INTEGER)');
db.close();
console.log('better-sqlite3 native module: OK');
"
