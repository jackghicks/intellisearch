# IntelliSearch

Semantic search for your VS Code workspace using local AI embeddings. Find code by concept, not just keywords — all without sending your code to a server.

## Features

- **Semantic vector search** — find code related to a concept or behaviour, even when the exact words don't match
- **Fully local** — embeddings are computed in-browser using [Transformers.js](https://github.com/xenova/transformers.js); no data leaves your machine
- **Copilot tool integration** — expose search to GitHub Copilot Chat, and any other chat, so it can query your codebase with `#intellisearch`
- **Incremental index updates** — file watchers keep the index up to date as you edit

## Usage

### Build the index

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Run **IntelliSearch: Build Index**

The panel opens and indexes every file in your workspace. This takes a moment on first run while the AI model loads and files are embedded.

### Search

- Use the search box in the IntelliSearch panel, **or**
- Reference `#intellisearch` in a GitHub Copilot chat message to let the AI search on your behalf

### Rebuild / update

Run **IntelliSearch: Build Index** again at any time to do a full rebuild. The index is updated automatically in the background as you save files.

## Extension Settings

No settings yet.

## Please Note

- Large workspaces may take several minutes to index on the first build
