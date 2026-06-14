#!/usr/bin/env bash
set -euo pipefail

GO_VERSION="1.26.4"
GO_ARCHIVE="go${GO_VERSION}.linux-amd64.tar.gz"
GO_URL="https://go.dev/dl/${GO_ARCHIVE}"
GO_SHA256="1153d3d50e0ac764b447adfe05c2bcf08e889d42a02e0fe0259bd47f6733ad7f"

tmpdir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

echo "Downloading ${GO_ARCHIVE}..."
curl -fsSL "$GO_URL" -o "$tmpdir/$GO_ARCHIVE"

echo "Verifying checksum..."
echo "${GO_SHA256}  $tmpdir/$GO_ARCHIVE" | sha256sum -c -

echo "Installing Go to /usr/local/go..."
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf "$tmpdir/$GO_ARCHIVE"

echo "Adding Go to system-wide PATH..."
echo 'export PATH=/usr/local/go/bin:$PATH' | sudo tee /etc/profile.d/go.sh >/dev/null
sudo chmod 0644 /etc/profile.d/go.sh

echo "Adding go and gofmt symlinks to /usr/local/bin..."
sudo ln -sfn /usr/local/go/bin/go /usr/local/bin/go
sudo ln -sfn /usr/local/go/bin/gofmt /usr/local/bin/gofmt

if [ -L "$HOME/.local/bin/go" ] && [ "$(readlink "$HOME/.local/bin/go")" = "$HOME/.local/go/bin/go" ]; then
  rm "$HOME/.local/bin/go"
fi

if [ -L "$HOME/.local/bin/gofmt" ] && [ "$(readlink "$HOME/.local/bin/gofmt")" = "$HOME/.local/go/bin/gofmt" ]; then
  rm "$HOME/.local/bin/gofmt"
fi

echo "Installed:"
/usr/local/go/bin/go version
echo
echo "Open a new terminal, or run:"
echo "  source /etc/profile.d/go.sh"
