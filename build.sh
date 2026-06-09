#!/bin/bash
# Build script that injects environment variables
# Usage: ./build.sh [GATEWAY_URL] [GATEWAY_TOKEN]

GATEWAY_URL="${1:-wss://undefined-background-stories-brands.trycloudflare.com}"
GATEWAY_TOKEN="${2:-e682960566d9436ba84bc65cb158708c561b66f6d52a4c6d9f542ae116ecfc5c}"

echo "Building with gateway: $GATEWAY_URL"

# Replace placeholders in JS
sed "s|__GATEWAY_URL__|$GATEWAY_URL|g; s|__GATEWAY_TOKEN__|$GATEWAY_TOKEN|g" src/main.js > src/main.injected.js
mv src/main.injected.js src/main.js

# Build
npx vite build

echo "Done! Deploy the 'dist' folder to Netlify."
