import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

// Stub the Workers-only "cloudflare:workers" module so the Worker can be
// imported and tested in plain Node. Mirrors WorkerEntrypoint(ctx, env).
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "cloudflare:workers") {
			return {
				url: "data:text/javascript,export class WorkerEntrypoint{constructor(ctx,env){this.ctx=ctx;this.env=env}}",
				shortCircuit: true,
			};
		}
		return nextResolve(specifier, context);
	},
});

// Node 22.18+ runs TypeScript directly (type stripping), so we test the exact
// file that gets deployed.
const {
	countSessionCookies,
	isHtmlNavigation,
	signInRedirectUrl,
	resolveConfig,
	decide,
	DEFAULTS,
	GatewayMiddleware,
} = await import("../src/index.ts");

// A realistic signed-in Google cookie header (values shortened).
const SIGNED_IN =
	"SID=g.a000abc; __Secure-1PSID=g.a000abc; __Secure-3PSID=g.a000abc; " +
	"HSID=AbCdEf; SSID=GhIjKl; APISID=MnOpQr/StUvWx; SAPISID=YzAbCd/EfGhIj; " +
	"__Secure-1PAPISID=YzAbCd/EfGhIj; __Secure-3PAPISID=YzAbCd/EfGhIj; NID=511=xyz; 1P_JAR=2026-10-29";

// What a signed-out browser typically carries after visiting google.com.
const SIGNED_OUT = "NID=511=xyz; 1P_JAR=2026-10-29; AEC=AVYB7co; SOCS=CAESHAgBEhJnd3NfMjAy";

function req(method, headers, url = "https://gemini.google.com/app") {
	return new Request(url, { method, headers });
}

// --- countSessionCookies -------------------------------------------------

test("countSessionCookies: signed-in header counts all nine", () => {
	assert.equal(countSessionCookies(SIGNED_IN), 9);
});

test("countSessionCookies: signed-out header counts zero", () => {
	assert.equal(countSessionCookies(SIGNED_OUT), 0);
});

test("countSessionCookies: null and empty are zero", () => {
	assert.equal(countSessionCookies(null), 0);
	assert.equal(countSessionCookies(""), 0);
});

test("countSessionCookies: tolerates odd spacing and valueless cookies", () => {
	assert.equal(countSessionCookies("  SID=a ;HSID=b;  SSID ; junk"), 3);
});

test("countSessionCookies: does not match prefixes or substrings", () => {
	// "SIDCC" is a real Google cookie that is NOT a session cookie.
	assert.equal(countSessionCookies("SIDCC=abc; __Secure-1PSIDCC=def; PSID=x"), 0);
});

test("countSessionCookies: honours a custom cookie list", () => {
	assert.equal(countSessionCookies("FOO=1; SID=2", ["FOO"]), 1);
});

// --- isHtmlNavigation ----------------------------------------------------

test("isHtmlNavigation: Sec-Fetch-Mode navigate", () => {
	assert.equal(isHtmlNavigation(req("GET", { "sec-fetch-mode": "navigate" })), true);
});

test("isHtmlNavigation: Sec-Fetch-Dest document", () => {
	assert.equal(isHtmlNavigation(req("GET", { "sec-fetch-dest": "document" })), true);
});

test("isHtmlNavigation: Accept text/html fallback for older clients", () => {
	assert.equal(isHtmlNavigation(req("GET", { accept: "text/html,application/xhtml+xml" })), true);
});

test("isHtmlNavigation: HEAD navigation counts", () => {
	assert.equal(isHtmlNavigation(req("HEAD", { "sec-fetch-mode": "navigate" })), true);
});

test("isHtmlNavigation: XHR/fetch is not a navigation", () => {
	assert.equal(isHtmlNavigation(req("GET", { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", accept: "*/*" })), false);
});

test("isHtmlNavigation: fetch() asking for HTML is not a navigation", () => {
	assert.equal(isHtmlNavigation(req("GET", { "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", accept: "text/html" })), false);
});

test("isHtmlNavigation: POST is never a navigation", () => {
	assert.equal(isHtmlNavigation(req("POST", { "sec-fetch-mode": "navigate", accept: "text/html" })), false);
});

test("isHtmlNavigation: script/image subresources pass", () => {
	assert.equal(isHtmlNavigation(req("GET", { "sec-fetch-dest": "script", accept: "*/*" })), false);
	assert.equal(isHtmlNavigation(req("GET", { "sec-fetch-dest": "image", accept: "image/avif,image/webp" })), false);
});

// --- signInRedirectUrl ---------------------------------------------------

test("signInRedirectUrl: targets ServiceLogin with encoded continue", () => {
	const u = new URL(signInRedirectUrl("https://gemini.google.com/app?x=1&y=2"));
	assert.equal(u.origin + u.pathname, "https://accounts.google.com/ServiceLogin");
	assert.equal(u.searchParams.get("continue"), "https://gemini.google.com/app?x=1&y=2");
	assert.equal(u.searchParams.has("hd"), false, "hd omitted when HOSTED_DOMAIN is empty");
	assert.equal(u.searchParams.has("passive"), false, "must be an active sign-in prompt");
});

test("signInRedirectUrl: adds hd when HOSTED_DOMAIN is set", () => {
	const config = resolveConfig({ HOSTED_DOMAIN: "example.com" });
	const u = new URL(signInRedirectUrl("https://gemini.google.com/app", config));
	assert.equal(u.searchParams.get("hd"), "example.com");
});

// --- resolveConfig -------------------------------------------------------

test("resolveConfig: empty env gives defaults", () => {
	assert.deepEqual(resolveConfig({}), { ...DEFAULTS, sessionCookieNames: [...DEFAULTS.sessionCookieNames] });
	assert.deepEqual(resolveConfig(undefined), resolveConfig({}));
});

test("resolveConfig: wrangler.jsonc vars match code defaults", () => {
	// Strip // comments (only at line start or after whitespace, so URLs survive).
	const text = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8").replace(/(^|\s)\/\/.*$/gm, "$1");
	const { vars } = JSON.parse(text);
	assert.deepEqual(resolveConfig(vars), resolveConfig({}));
});

test("resolveConfig: accepts string values from the dashboard", () => {
	const c = resolveConfig({
		OBSERVE_ONLY: "true",
		MIN_SESSION_COOKIES: "2",
		SESSION_COOKIE_NAMES: "SID, HSID ,SSID",
		TARGET_HOST: " Gemini.Google.com ",
	});
	assert.equal(c.observeOnly, true);
	assert.equal(c.minSessionCookies, 2);
	assert.deepEqual(c.sessionCookieNames, ["SID", "HSID", "SSID"]);
	assert.equal(c.targetHost, "gemini.google.com");
	assert.deepEqual(resolveConfig({ SESSION_COOKIE_NAMES: '["A","B"]' }).sessionCookieNames, ["A", "B"]);
});

test("resolveConfig: invalid values fall back safely", () => {
	const c = resolveConfig({
		OBSERVE_ONLY: "maybe",
		MIN_SESSION_COOKIES: "zero",
		SESSION_COOKIE_NAMES: [],
		SIGN_IN_URL: "not a url",
	});
	assert.equal(c.observeOnly, false);
	assert.equal(c.minSessionCookies, 3);
	assert.equal(c.sessionCookieNames.length, 9);
	assert.equal(c.signInUrl, DEFAULTS.signInUrl);
});

test("resolveConfig: MIN_SESSION_COOKIES is capped at the list length", () => {
	// Otherwise every user would be redirected forever.
	assert.equal(resolveConfig({ SESSION_COOKIE_NAMES: ["SID", "HSID"], MIN_SESSION_COOKIES: 5 }).minSessionCookies, 2);
});

// --- decide --------------------------------------------------------------

test("decide: signed-out navigation redirects; observe-only passes", () => {
	const nav = () => req("GET", { "sec-fetch-mode": "navigate", cookie: SIGNED_OUT });
	assert.equal(decide(nav(), resolveConfig({})).action, "redirect");
	assert.equal(decide(nav(), resolveConfig({ OBSERVE_ONLY: true })).action, "pass");
});

test("decide: signed-in navigation passes", () => {
	const r = decide(req("GET", { "sec-fetch-mode": "navigate", cookie: SIGNED_IN }), resolveConfig({}));
	assert.equal(r.signedIn, true);
	assert.equal(r.action, "pass");
});

// --- GatewayMiddleware end to end -----------------------------------------

function worker(env = {}) {
	return new GatewayMiddleware({}, env);
}
const upstream = async () => new Response("gemini", { status: 200, headers: { "content-type": "text/html" } });
const ctx = (host = "gemini.google.com") => ({ host, uri: `${host}/app` });

test("GatewayMiddleware: redirects a signed-out navigation", async (t) => {
	t.mock.method(console, "log", () => {});
	const res = await worker({ HOSTED_DOMAIN: "example.com" }).handle(
		req("GET", { "sec-fetch-mode": "navigate" }),
		ctx(),
		upstream,
	);
	assert.equal(res.status, 302);
	const loc = new URL(res.headers.get("location"));
	assert.equal(loc.searchParams.get("continue"), "https://gemini.google.com/app");
	assert.equal(loc.searchParams.get("hd"), "example.com");
	assert.equal(res.headers.get("x-gateway-worker"), "gemini-signin-gate");
});

test("GatewayMiddleware: passes signed-in traffic with marker header", async (t) => {
	t.mock.method(console, "log", () => {});
	const res = await worker().handle(req("GET", { "sec-fetch-mode": "navigate", cookie: SIGNED_IN }), ctx(), upstream);
	assert.equal(res.status, 200);
	assert.equal(await res.text(), "gemini");
	assert.equal(res.headers.get("x-gateway-worker"), "gemini-signin-gate");
});

test("GatewayMiddleware: ignores other hosts untouched", async (t) => {
	const log = t.mock.method(console, "log", () => {});
	const res = await worker().handle(req("GET", { "sec-fetch-mode": "navigate" }, "https://mail.google.com/"), ctx("mail.google.com"), upstream);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("x-gateway-worker"), null);
	assert.equal(log.mock.callCount(), 0);
});
