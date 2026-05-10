#!/bin/bash
set -e
cd "$(dirname "$0")/.."

# Load TUNNEL_NAME and TUNNEL_HOSTNAME from .env
if [ -f .env ]; then
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    case "$key" in
      TUNNEL_NAME|TUNNEL_HOSTNAME) export "$key"="$value" ;;
    esac
  done < .env
fi

TUNNEL_NAME="${TUNNEL_NAME:-}"
TUNNEL_HOSTNAME="${TUNNEL_HOSTNAME:-}"

if [ -z "$TUNNEL_NAME" ]; then
  echo "❌ TUNNEL_NAME ist nicht in .env gesetzt"
  exit 1
fi
if [ -z "$TUNNEL_HOSTNAME" ]; then
  echo "❌ TUNNEL_HOSTNAME ist nicht in .env gesetzt"
  exit 1
fi

echo "🚇 Cloudflare Tunnel Setup — $TUNNEL_HOSTNAME"
echo "=================================================="
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
credentials-file: /root/.cloudflared/$TUNNEL_ID.json

ingress:
  - hostname: $TUNNEL_HOSTNAME
    service: http://localhost:4000
  - service: http_status:404
EOF
echo "✓ Config written to ~/.cloudflared/config.yml"

# Route DNS
echo "Routing $TUNNEL_HOSTNAME → tunnel..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$TUNNEL_HOSTNAME" 2>&1 || \
  echo "  (DNS entry may already exist — ok)"

echo ""
echo "✅ Done! Start the tunnel with:"
echo "   npm run tunnel"
echo ""
echo "   Or auto-start on boot:"
echo "   sudo cloudflared service install"
