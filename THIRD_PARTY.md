# Sources and licenses

This project combines the TypeScript service foundation of:

- https://github.com/classfang/ssh-mcp-server — ISC, source revision `f814a4e7205703cb1b910e48d1de5d5c37b2cc63`.

with the remote editing, named session, search, synchronization and forwarding capabilities inspired by:

- https://github.com/slepp/ssh-mcp — MIT, source revision `37381ddc68a941b62ed8557dcbb5644dc3b6c5fd`.

Original license notices are preserved under `LICENSES/`. Original local checkouts remain outside the distributed package. Python code is not required at runtime. New integration code is provided under the ISC terms in `LICENSE`.

Additional runtime dependencies retain their own distributed license notices: `node-pty` (Microsoft, MIT) provides native pseudoterminals, and `diff` (jsdiff, BSD-3-Clause) generates bounded edit previews. node-pty is pinned to 1.1.0; `scripts/prepare-pty.js` restores executable permissions on its macOS spawn-helper when needed.
