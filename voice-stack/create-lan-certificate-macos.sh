#!/usr/bin/env bash
set -euo pipefail
umask 077

TLS_DIR="${MUSE_TLS_DIR:-$HOME/.local/share/muse/tls}"
LOCAL_NAME="$(scutil --get LocalHostName).local"
CA_KEY="$TLS_DIR/ca.key"
CA_CERT="$TLS_DIR/ca.crt"
SERVER_KEY="$TLS_DIR/server.key"
SERVER_CSR="$TLS_DIR/server.csr"
SERVER_CERT="$TLS_DIR/server.crt"
EXT_FILE="$TLS_DIR/server.ext"

mkdir -p "$TLS_DIR"
chmod 700 "$TLS_DIR"
for path in "$CA_KEY" "$CA_CERT" "$SERVER_KEY" "$SERVER_CERT"; do
  if [[ -e "$path" ]]; then
    echo "Refusing to overwrite existing certificate file: $path" >&2
    exit 1
  fi
done

SAN="DNS:$LOCAL_NAME,DNS:localhost,IP:127.0.0.1"
for interface in en0 en1; do
  address="$(ipconfig getifaddr "$interface" 2>/dev/null || true)"
  if [[ -n "$address" ]]; then SAN+=",IP:$address"; fi
done

openssl genrsa -out "$CA_KEY" 3072
openssl req -x509 -new -key "$CA_KEY" -sha256 -days 3650 \
  -out "$CA_CERT" -subj "/CN=Muse LAN Root CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl req -new -newkey rsa:2048 -nodes \
  -keyout "$SERVER_KEY" -out "$SERVER_CSR" \
  -subj "/CN=$LOCAL_NAME"
cat > "$EXT_FILE" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SAN
EOF
openssl x509 -req -in "$SERVER_CSR" -CA "$CA_CERT" -CAkey "$CA_KEY" \
  -CAcreateserial -out "$SERVER_CERT" -days 825 -sha256 -extfile "$EXT_FILE"
rm -f "$SERVER_CSR" "$EXT_FILE" "$TLS_DIR/ca.srl"
chmod 600 "$CA_KEY" "$SERVER_KEY"
chmod 644 "$CA_CERT" "$SERVER_CERT"

echo "Muse TLS files created in: $TLS_DIR"
echo "Install and trust this CA certificate on each client device: $CA_CERT"
echo "Set MUSE_TLS_CERT=$SERVER_CERT"
echo "Set MUSE_TLS_KEY=$SERVER_KEY"
echo "The server certificate includes $LOCAL_NAME and the current en0/en1 IPv4 addresses."
