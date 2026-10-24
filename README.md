# lampac-mcp (Alpha)

An early, client-neutral MCP server with a small Lampa plugin. It lets an MCP client manage one AI-curated carousel and inspect which Lampac sources are currently listed for a title.

The carousel is stored by this service as JSON. The prototype does not write to CUB collections, Lampac `catalog/card`, or Lampa's own data stores.

## What is included

- MCP endpoint at `/mcp` using JSON-RPC over Streamable HTTP (2025-11-25).
- `get_ai_collection` — read the current carousel.
- `replace_ai_collection` — replace its title and TMDB cards. Disabled by default; when enabled, the MCP client must be configured to request human approval, and the call must include the approval phrase shown in the tool schema.
- `inspect_title_sources` — make a read-only `/lite/events` request to a configured Lampac instance for one TMDB title. This is a snapshot, not a root-cause diagnosis or an automatic fix.
- `get_tvctl_log` — optionally read the latest reports from `EX.TvCtl`; it sends no commands to a device.
- `plugin/lampac-mcp.js` — register a carousel row on Lampa's main and category screens.
- `GET /api/collection` — read-only JSON feed used by the Lampa plugin.

The plugin uses the documented `Lampa.ContentRows.add` API and requires Lampa 3.0 or later. See the [Lampa migration guide](https://github.com/yumata/lampa-source/blob/main/UPGRADE.md#lampa-contentrows).

## Run locally

Requires Node.js 20 or later. The server uses Node's built-in modules and has no runtime package dependencies.

```sh
cp .env.example .env
```

Set `MCP_TOKEN` to a private random value of at least 32 characters. Add the exact web origins of MCP clients to `ALLOWED_ORIGINS`. Native clients that omit the `Origin` header still need the bearer token. Keep `HOST=127.0.0.1` when using a local reverse proxy; only bind to a network interface when that is intentional.

```sh
set -a
. ./.env
set +a
npm start
```

The MCP URL is `http://127.0.0.1:8787/mcp`. The server rejects a present `Origin` that is not in `ALLOWED_ORIGINS`, and requires bearer authentication on `/mcp`. Do not expose the MCP endpoint through a public reverse proxy without HTTPS and the configured token.

## Tests

Run the built-in Node test suite with `npm test`. It starts temporary server processes bound to loopback, uses a temporary collection file, and does not contact a Lampac instance.

### Enable collection writes

Writes are off by default. Set `MCP_ENABLE_WRITES=true` only after configuring the chosen MCP host to show a human approval prompt for tool calls. The `replace_ai_collection` call also requires this exact phrase:

```text
I have reviewed and approve replacing the AI collection.
```

MCP itself does not enforce a client confirmation UI; the host's approval prompt is part of this Alpha's safety boundary. The approval phrase is an additional guard, not proof that a human approved the call.

Collection data is saved to `./data/collections.json` by default. Set `COLLECTIONS_FILE` to choose another location. The feed is intentionally public to the Lampa plugin; do not put private notes in card fields.

### Connect Lampa

Serve this service and the plugin from the same HTTPS origin. Add the plugin URL in Lampa's Extensions settings:

```text
https://your-host.example/plugin.js
```

The plugin reads `https://your-host.example/api/collection`. The MCP endpoint remains `/mcp`; configure it separately in any MCP client that supports Streamable HTTP. Each host has its own server-connection setup, but the MCP tools and schemas are client-neutral.

### Read-only diagnostics

Set `LAMPAC_URL` to the base URL of the Lampac instance, then call `inspect_title_sources` with the TMDB id, `movie` or `tv`, and the title. Optional fields include original title/language, year, IMDb id, and `is_anime`. The service makes a read-only request to `/lite/events`.

To use `get_tvctl_log`, configure `LAMPAC_ROOT_PASSWORD` using the deployment's secret manager. This tool calls the read-only `/tvctl/log` route and returns at most 200 report lines. It does not send commands, restart services, or change configuration. Do not put the password in source control, MCP tool arguments, or logs.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_TOKEN` | none | Required bearer token; at least 32 characters |
| `ALLOWED_ORIGINS` | none | Comma-separated exact origins allowed on `/mcp` |
| `HOST` | `127.0.0.1` | Listen address |
| `PORT` | `8787` | Listen port |
| `LAMPAC_URL` | none | Lampac base URL for source inspection |
| `LAMPAC_ROOT_PASSWORD` | none | Lampac root password for optional read-only EX.TvCtl log access |
| `MCP_ENABLE_WRITES` | `false` | Enables the collection replacement tool |
| `COLLECTIONS_FILE` | `./data/collections.json` | JSON persistence path |

## Protocol and safety notes

- The endpoint implements initialization, `tools/list`, `tools/call`, `ping`, and notifications needed by the 2025-11-25 Streamable HTTP flow. GET on `/mcp` returns 405; the server does not open a server-to-client SSE stream.
- `Origin` is checked when present, as required by the [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports). Authentication is bearer-token based.
- Use trusted MCP clients. Tool metadata and server-side phrases cannot replace the host application's human approval UI.
- This is an Alpha. It has not been deployed to a Lampac server or verified on a TV in this repository.

## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).
