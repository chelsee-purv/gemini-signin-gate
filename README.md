# Require Google sign-in before Gemini

A Cloudflare Gateway [Forward](https://developers.cloudflare.com/cloudflare-one/traffic-controls/integrate-workers/forward-traffic/) Worker. It sends signed-out browsers to Google sign-in before they reach `gemini.google.com`, so that [Google Workspace tenant control](https://developers.cloudflare.com/cloudflare-one/traffic-controls/http-policies/tenant-control/#saas-tenant-control) has a sign-in to act on.

## Why you need it

Cloudflare tenant control adds the `X-GoogApps-Allowed-Domains` header to requests to Google, and Google enforces it when a user signs in. Google's documentation for the header also says:

> This approach blocks sign-in access to Google consumer services other than Google Search, but **doesn't necessarily prohibit anonymous access**.

Gemini works for a browser that is not signed in, so a user who never signs in is never checked by tenant control.

| Control | What it enforces | What it cannot do |
|---|---|---|
| Tenant control (Allow policy + header) | Only your domains can complete a Google sign-in | Make a sign-in happen |
| This Worker (Forward policy) | A sign-in has to happen before Gemini loads | Check which account signs in |

With both in place, every Gemini session is a corporate Google session.

## Quick start

Prerequisites: [Node.js](https://nodejs.org/) 22.18 or later, a Cloudflare account with Zero Trust (Gateway HTTP filtering and TLS inspection turned on), and access to Gateway Forward policies.

```bash
git clone https://github.com/chelsee-purv/gemini-signin-gate.git
cd gemini-signin-gate
npm install
npx wrangler login
```

**1. Edit your settings.** Open `wrangler.jsonc`. Most deployments only change one value:

```jsonc
"HOSTED_DOMAIN": "example.com",   // your Google Workspace primary domain
```

**2. Deploy.**

```bash
npm run check    # optional: typecheck, tests, and a bundle dry run
npm run deploy
```

**3. Create the Gateway policies** in [Cloudflare One](https://one.dash.cloudflare.com/) under **Traffic policies** > **HTTP**:

| Order | Policy | Selector | Action |
|---|---|---|---|
| 1 | Tenant control | **Application** *in* *Google Workspace* | **Allow**, with the `X-GoogApps-Allowed-Domains` header set to your domains ([guide](https://developers.cloudflare.com/cloudflare-one/traffic-controls/http-policies/tenant-control/#saas-tenant-control)) |
| 2 | Gemini sign-in gate | **Host** *is* `gemini.google.com` | **Forward**, Worker `gemini-signin-gate` |

Keep the tenant control policy scoped to the whole Google Workspace application, not just `gemini.google.com`. Google needs the header on `accounts.google.com` during sign-in. An Allow decision does not skip the Forward phase, so both policies apply to the same request.

Before you add the Forward policy, check that tenant control works on its own: sign in to Google with a personal account from a device behind Gateway. Google should show a page saying the account is not allowed on this network.

## Configuration

All settings are in the `vars` block of [`wrangler.jsonc`](wrangler.jsonc). You do not need to edit any code. After the first deploy you can also change them in the Cloudflare dashboard under **Workers & Pages** > *your Worker* > **Settings** > **Variables and Secrets**. If you edit them there, add `--keep-vars` to later `wrangler deploy` runs so the dashboard values are not replaced.

| Variable | Default | What it does |
|---|---|---|
| `HOSTED_DOMAIN` | `""` | Your Workspace primary domain. Adds `hd=<domain>` to the redirect so Google's account chooser shows corporate accounts first. This is a hint, not an access control |
| `OBSERVE_ONLY` | `false` | When `true`, the Worker logs what it would have done and never redirects. Use this for a staged rollout |
| `TARGET_HOST` | `gemini.google.com` | The host the Worker acts on. Match it in the Forward policy |
| `SIGN_IN_URL` | `https://accounts.google.com/ServiceLogin` | Where signed-out browsers are sent. This is the same URL Gemini's own "Sign in" link uses |
| `MIN_SESSION_COOKIES` | `3` | How many of the cookies below a request needs to count as signed in |
| `SESSION_COOKIE_NAMES` | 9 Google session cookies | Cookie names that show a Google session. Accepts a JSON array or a comma-separated string |

If a value is missing or invalid, the Worker uses the default. To rename the Worker, change `"name"` at the top of `wrangler.jsonc` and pick the new name in the Forward policy.

## Test

From a device in the policy's scope:

1. Sign out of all Google accounts and go to `https://gemini.google.com/app`. The browser should land on Google sign-in, with the Gemini URL in the `continue` parameter.
2. Enter a personal Gmail address. Google should show its tenant control page, which confirms the header reached `accounts.google.com`.
3. Sign in with a corporate account. Google sends you back to Gemini, and the page loads with the response header `x-gateway-worker: gemini-signin-gate`.
4. Send a prompt. API calls are not page loads, so they pass through without being checked.

Each decision is written to [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) as one JSON line, for example:

```json
{"event":"gemini-signin-gate","uri":"gemini.google.com/app","observeOnly":false,"navigation":true,"sessionCookies":0,"signedIn":false,"action":"redirect"}
```

**Staged rollout:** deploy with `OBSERVE_ONLY: true`, check Workers Logs for how often navigations show `"signedIn":false`, then set it to `false` and deploy again to start redirecting.

## How it works

The Worker only acts on top-level page loads: `GET` or `HEAD` requests with `Sec-Fetch-Mode: navigate` or `Sec-Fetch-Dest: document`. For older clients that do not send `Sec-Fetch-*` headers, it uses `Accept: text/html` instead. Scripts, images, and API calls pass through unchanged. If a page load carries fewer than `MIN_SESSION_COOKIES` Google session cookies, the Worker returns a `302` to `SIGN_IN_URL`, with `continue` set to the original URL so the user comes back to the same page after signing in. Every other request goes through `next()` and gets the marker header added.

## Limitations

- **This Worker is not the security control.** It checks cookie names, not Google's session state. Someone who sets fake cookies with the right names gets past it, and Google then treats them as signed out. The tenant control header is what decides which accounts can sign in. This Worker makes sure a normal user is asked to sign in.
- **Google's session cookie names are not a documented contract.** If Google renames them, signed-in users could be sent to sign-in over and over. `OBSERVE_ONLY` and Workers Logs will show this before users are affected. If it happens, update `SESSION_COOKIE_NAMES` and `MIN_SESSION_COOKIES`.
- **`hd` is only a hint.** Users can still choose a different account. Only tenant control limits which accounts can finish signing in.
- **Embedded Gemini is not covered.** The Worker does not affect Gemini inside other Workspace apps, such as the side panel in Gmail or Docs. Those already need a Workspace sign-in, so tenant control applies to them directly.

## Project layout

| Path | Purpose |
|---|---|
| `wrangler.jsonc` | Worker name and all settings |
| `src/index.ts` | The Worker |
| `test/index.test.js` | Unit and end-to-end tests (`node:test`, no extra dependencies) |

```bash
npm run typecheck   # tsc --noEmit
npm test            # unit + handler tests
npm run check       # both, plus a wrangler bundle dry run
```
