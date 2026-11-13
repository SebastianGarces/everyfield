# Sourced by bin/dev, bin/qa and bin/wiki after they set `tool`. Sets node_bin to a Node 24+ binary: node on PATH
# when it is new enough, else the newest nvm install of Node 24 or later. Exits 1 naming the tool when none exists.
node_bin=node
if ! "$node_bin" -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' 2>/dev/null; then
  node_bin=""
  for candidate in "$HOME"/.nvm/versions/node/v2[4-9]*/bin/node; do
    [ -x "$candidate" ] && node_bin="$candidate"
  done
  if [ -z "$node_bin" ]; then
    echo "$tool: Node 24+ is required." >&2
    exit 1
  fi
fi
