#!/bin/bash
set -e

npm install --prefer-offline --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund
npm run db:push 2>/dev/null || true
