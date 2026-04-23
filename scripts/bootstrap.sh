#!/bin/bash
set -e

echo "=== Hermes Trading Firm Bootstrap ==="

# Check Node.js version
NODE_VERSION=$(node --version 2>/dev/null || echo "none")
if [ "$NODE_VERSION" = "none" ]; then
  echo "ERROR: Node.js is not installed. Please install Node.js 22+."
  exit 1
fi

# Check npm
if ! command -v npm &> /dev/null; then
  echo "ERROR: npm is not installed."
  exit 1
fi

# Install dependencies
echo "Installing dependencies..."
npm install

# Copy .env if missing
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    echo "Creating .env from .env.example..."
    cp .env.example .env
  else
    echo "WARNING: No .env.example found. You'll need to create .env manually."
  fi
else
  echo ".env already exists."
fi

# Start Docker services if docker compose is available
if command -v docker &> /dev/null && docker compose version &> /dev/null; then
  echo "Starting Docker services (Redis, Postgres)..."
  docker compose up -d
else
  echo "WARNING: Docker not available. You'll need to run Redis and Postgres manually."
fi

echo ""
echo "=== Bootstrap complete ==="
echo "Next steps:"
echo "  - Run 'tilt up' to start all services"
echo "  - Or run 'npm run dev' to start core services via concurrently"
