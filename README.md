# n8n-nodes-better-http-request

An enhanced **HTTP Request** community node for [n8n](https://n8n.io) that adds automatic retry logic for failed items on top of all the capabilities already provided by the built-in HTTP Request node.

## Features

- **All standard HTTP Request capabilities** – HTTP methods (GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS), query parameters, request headers, JSON/form/raw bodies, file uploads, pagination, batching, authentication, SSL certificates, and more.
- **Retry failed items** – automatically re-sends requests that failed with configurable HTTP status codes. Unlike the built-in node's retry which re-runs every item, this feature retries *only* the items that failed, leaving successful items untouched.
  - Configurable maximum retry attempts (default: 3).
  - Configurable delay between retries (default: 1000 ms).
  - Configurable list of retriable status codes (default: `429,500,502,503,504`).
  - Respects the `Retry-After` response header for HTTP 429 responses.
- **Domain restrictions** – credential-level allowlists prevent requests from being sent to unauthorized domains.

## Installation

### In your n8n instance

1. Open **Settings → Community Nodes**.
2. Click **Install a community node**.
3. Enter `n8n-nodes-better-http-request` and confirm the installation.

### Manual / self-hosted

```bash
npm install n8n-nodes-better-http-request
```

Then restart n8n.

## Usage

After installation the node appears in the node palette as **Better HTTP Request**.

### Basic request

1. Add a **Better HTTP Request** node to your workflow.
2. Set the **Method** (GET, POST, …) and the **URL**.
3. Optionally configure **Query Parameters**, **Headers**, and a **Body** in the respective sections.
4. Execute the workflow.

### Retry failed items

1. Enable **Continue On Fail** on the node (gear icon → *Continue On Fail*).
2. Open the **Options** section and turn on **Retry Failed Items**.
3. Adjust **Max Retries**, **Retry Delay (ms)**, and **Retry On Status Codes** to your needs.

When the workflow runs, any item whose request returns one of the configured status codes will be retried up to the specified number of times. All other items pass through immediately without waiting.

## Options reference

| Option | Default | Description |
|---|---|---|
| **Retry Failed Items** | `false` | Enable automatic retry for failed items. Requires *Continue On Fail* to be active. |
| **Max Retries** | `3` | Maximum number of retry attempts per failed item (1–10). |
| **Retry Delay (ms)** | `1000` | Milliseconds to wait between retry attempts. For HTTP 429, the `Retry-After` header value takes precedence. |
| **Retry On Status Codes** | `429,500,502,503,504` | Comma-separated list of HTTP status codes that trigger a retry. |
| **Batching** | – | Split items into batches and add a delay between them to avoid rate limits. |
| **Timeout** | `300000` (5 min) | Time in ms to wait for the server to start responding before aborting. |
| **Send Credentials on Cross-Origin Redirect** | `false` | Forward auth headers when following cross-origin redirects. |

## Development

```bash
# Install dependencies
npm ci

# Build
npm run build

# Run tests
npm test
```

The project is written in TypeScript. The compiled output is placed in `dist/`.

## License

MIT
