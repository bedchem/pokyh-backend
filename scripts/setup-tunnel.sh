#!/bin/bash
set -e
cd "$(dirname "$0")/.."

echo "🚇 Cloudflare Tunnel Setup — api.pokyh.com"
echo "==========================================="
echo ""

if ! command -v cloudflared &> /dev/null; then
  echo "❌ cloudflared not found. Install with: brew install cloudflare/cloudflare/cloudflared"
  exit 1
fi
echo "✓ $(cloudflared --version 2>&1 | head -1)"
echo ""

# Login (opens browser once, saves ~/.cloudflared/cert.pem)
if [ ! -f ~/.cloudflared/cert.pem ]; then
  echo "Step 1: Login to Cloudflare (browser will open)..."
  cloudflared tunnel login
  echo ""
else
  echo "✓ Already logged in to Cloudflare"
fi

# Create tunnel if needed
TUNNEL_NAME="pokyh-api"
if cloudflared tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
  echo "✓ Tunnel '$TUNNEL_NAME' already exists"
else
  echo "Creating tunnel '$TUNNEL_NAME'..."
  cloudflared tunnel create "$TUNNEL_NAME"
fi

# Get tunnel ID
TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | grep "$TUNNEL_NAME" | awk '{print $1}')
echo "✓ Tunnel ID: $TUNNEL_ID"

# Write config
mkdir -p ~/.cloudflared
cat > ~/.cloudflared/config.yml << EOF
tunnel: $TUNNEL_ID
credentials-file: /Users/$(whoami)/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: api.pokyh.com
    service: http://localhost:4000
  - service: http_status:404
EOF
echo "✓ Config written to ~/.cloudflared/config.yml"

# Route DNS
echo "Routing api.pokyh.com → tunnel..."
cloudflared tunnel route dns "$TUNNEL_NAME" api.pokyh.com 2>&1 || \
  echo "  (DNS entry may already exist — ok)"

echo ""
echo "✅ Done! Start the tunnel with:"
echo "   npm run tunnel"
echo ""
echo "   Or auto-start on boot:"
echo "   sudo cloudflared service install"
