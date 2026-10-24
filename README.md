# lampac-mcp (Alpha)

A client-neutral MCP server for [Lampa](https://github.com/yumata/lampa-source) behind
[Lampac](https://github.com/lampac-nextgen/lampac). An MCP client (an AI assistant) curates the rows of
Lampa's main screen; Lampa shows them instead of its usual TMDB rows. The same service can stand in for
CUB, Lampa's cloud service, so that Lampa's CUB requests stay on your network.

Rows are stored by this service as JSON. It does not write to CUB, Lampac `catalog/card`, or Lampa's own data.

## What is included

- MCP endpoint at `/mcp` using JSON-RPC over Streamable HTTP (2025-11-25).
- `get_ai_rows` — read the main-screen rows in display order.
- `set_ai_row` — create or replace one row: `id`, `title`, `kind` (`movies`, `series`, `cartoons`, `anime`),
  `style` (`poster` or `wide` 16:9 cards), TMDB cards, optional `position`. Disabled by default (see below).
- `delete_ai_row` — remove a row. Disabled by default.
- `inspect_title_sources` — a read-only `/lite/events` request to a configured Lampac instance for one TMDB
  title. This is a snapshot, not a root-cause diagnosis or an automatic fix.
- `get_tvctl_log` — optionally read the latest reports from `EX.TvCtl`; it sends no commands to a device.
- `GET /api/collection` — read-only feed for the Lampa plugin: `rows`, plus the first row as `title`/`items`
  for older plugin builds.
- `/cub/*` — local CUB stand-in (see below) and `GET /api/cub-log` with the last requested paths.
- `plugin/lampac-mcp.js` — Lampa 3 plugin that builds the main screen from the rows.

## Run

### Docker

```sh
docker build -t lampac-mcp .
docker run -d --name lampac-mcp --restart unless-stopped \
  -e MCP_TOKEN=... -e MCP_ENABLE_WRITES=false \
  -v "$PWD/data:/data" -p 8787:8787 lampac-mcp
```

The image listens on all interfaces inside the container (`HOST=0.0.0.0`) and keeps rows in `/data`.
Publish the port only where you need it.

### Node

Requires Node.js 20 or later; only Node's built-in modules are used, there are no runtime dependencies.

```sh
cp .env.example .env    # set MCP_TOKEN to a random value of at least 32 characters
set -a; . ./.env; set +a
npm start
```

The MCP URL is `http://<host>:8787/mcp`. The server rejects a present `Origin` that is not in
`ALLOWED_ORIGINS` and requires bearer authentication on `/mcp`. Keep it on a trusted network; do not expose it
through a public reverse proxy without HTTPS, the token and an extra login in front.

## Tests

`npm test` starts temporary server processes on loopback with a temporary data file; it does not contact Lampac.

## Enable row writes

Writes are off by default. Set `MCP_ENABLE_WRITES=true` only after configuring the MCP host to show a human
approval prompt for tool calls. `set_ai_row` and `delete_ai_row` also require this exact phrase:

```text
I have reviewed and approve changing the AI rows.
```

MCP itself does not enforce a confirmation UI; the host's approval prompt is part of the safety boundary.
The phrase is an additional guard, not proof that a human approved the call.

Rows are saved to `./data/collections.json` (`/data/collections.json` in Docker); set `COLLECTIONS_FILE` to
change it. A file from the first alpha (one `{ title, items }` collection) is read as one wide row.
The feed is public to the Lampa plugin; do not put private notes in card fields.

## Connect Lampa

The recommended way is through Lampac, so that Lampa reads the feed from its own origin (no CORS, no mixed
http/https): module `EX.Mcp` and the plugin from [lampac-extra](https://github.com/TrueNihilisme/lampac-extra#rows).

```json
"EX.Mcp": { "collectionUrl": "http://<lampac-mcp host>:8787/api/collection" }
```

The plugin replaces the main screen of Lampa's TMDB source with the rows; rows of Lampa itself and other
plugins ("Continue watching", episode releases) follow at the bottom. Card details (poster or backdrop,
title, overview, rating) come from Lampa's own TMDB source and are cached on the device for a day.
Without rows, or when the feed is unreachable, the usual TMDB main screen is shown.
Checked with Lampa 3.3.4 on Samsung Tizen 4.0 and Android TV.

## Local CUB stand-in

Lampac's `CubProxy` forwards Lampa's `/cub/red/<path>` requests to `{cub.scheme}://{cub.domain}/<path>`.
Point it at this service to keep them local:

```json
"cub": { "scheme": "http", "domain": "<lampac-mcp host>:8787/cub", "useproxy": false }
```

Keep `cub.api_key` and `cub.mirror` as they are: other Lampac modules read them from the same section.
The stand-in answers 404 to API calls (Lampa then shows no comments, reactions or CUB collections), an empty
script for `/cub/plugin/*`, and accepts POSTs (logs, reactions) without storing them. `GET /api/cub-log`
lists the last 200 requested paths without query strings.

Some requests do not go through Lampac: Lampa 3.3.4 sends `https://tmdb.cub.best/watch?id=…` when a title
enters the history, ads requests and WebSocket connections straight from the device. Turn off what Lampa allows in
`lampainit.js` (`lampa_settings.socket_use`, `account_use`, `disable_features.discuss` and others) and block
the CUB domains in your DNS for the rest.

## Read-only diagnostics

Set `LAMPAC_URL` to the Lampac base URL, then call `inspect_title_sources` with the TMDB id, `movie` or `tv`,
and the title. Optional fields: original title/language, year, IMDb id, `is_anime`.

`get_tvctl_log` needs `LAMPAC_ROOT_PASSWORD` from your secret manager. It calls the read-only `/tvctl/log`
route and returns at most 200 lines. Do not put the password in source control, tool arguments or logs.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `MCP_TOKEN` | none | Required bearer token; at least 32 characters |
| `ALLOWED_ORIGINS` | none | Comma-separated exact origins allowed on `/mcp` |
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Listen address |
| `PORT` | `8787` | Listen port |
| `LAMPAC_URL` | none | Lampac base URL for source inspection |
| `LAMPAC_ROOT_PASSWORD` | none | Lampac root password for optional read-only EX.TvCtl log access |
| `MCP_ENABLE_WRITES` | `false` | Enables `set_ai_row` and `delete_ai_row` |
| `COLLECTIONS_FILE` | `./data/collections.json` | JSON persistence path |

## Protocol and safety notes

- The endpoint implements initialization, `tools/list`, `tools/call`, `ping`, and notifications needed by the
  2025-11-25 Streamable HTTP flow. GET on `/mcp` returns 405; there is no server-to-client SSE stream.
- `Origin` is checked when present, as required by the
  [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
  Authentication is bearer-token based.
- Use trusted MCP clients. Tool metadata and server-side phrases cannot replace the host's approval UI.

## License

GNU Affero General Public License v3.0 only. See [LICENSE](LICENSE).
