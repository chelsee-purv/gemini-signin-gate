import { WorkerEntrypoint } from "cloudflare:workers";
import type {
	GatewayMiddlewareContext,
	GatewayMiddlewareNext,
} from "@cloudflare/zt-types";

/**
 * Require a Google sign-in before Gemini.
 *
 * Google's X-GoogApps-Allowed-Domains tenant control header restricts which
 * Workspace domains can sign in, but Google documents that it "doesn't
 * necessarily prohibit anonymous access". Gemini serves a working app to a
 * browser that is not signed in, so tenant control never engages.
 *
 * This Worker closes that gap. When a browser navigates to gemini.google.com
 * without Google session cookies, it redirects to Google sign-in. Pair it with
 * the Google Workspace tenant control policy so that the sign-in it forces can
 * only complete with a corporate account.
 *
 * All settings live in the "vars" block of wrangler.jsonc. You should not need
 * to edit this file.
 */

/**
 * Settings read from wrangler.jsonc "vars" (or the dashboard). Values may
 * arrive as JSON types or, if edited as plain text in the dashboard, as
 * strings, so every field is parsed leniently.
 */
export interface Env {
	TARGET_HOST?: string;
	SIGN_IN_URL?: string;
	HOSTED_DOMAIN?: string;
	SESSION_COOKIE_NAMES?: string[] | string;
	MIN_SESSION_COOKIES?: number | string;
	OBSERVE_ONLY?: boolean | string;
}

export interface Config {
	targetHost: string;
	signInUrl: string;
	hostedDomain: string;
	sessionCookieNames: string[];
	minSessionCookies: number;
	observeOnly: boolean;
}

/** Used when a setting is missing or empty. Matches wrangler.jsonc. */
export const DEFAULTS: Readonly<Config> = Object.freeze({
	targetHost: "gemini.google.com",
	signInUrl: "https://accounts.google.com/ServiceLogin",
	hostedDomain: "",
	sessionCookieNames: [
		"SID",
		"HSID",
		"SSID",
		"APISID",
		"SAPISID",
		"__Secure-1PSID",
		"__Secure-3PSID",
		"__Secure-1PAPISID",
		"__Secure-3PAPISID",
	],
	minSessionCookies: 3,
	observeOnly: false,
});

/** Marker header on Worker responses, for verifying the Worker ran. */
const MARKER_HEADER = "x-gateway-worker";
const MARKER_VALUE = "gemini-signin-gate";

function str(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function list(value: unknown, fallback: string[]): string[] {
	let items: unknown = value;
	if (typeof value === "string") {
		const text = value.trim();
		if (text.startsWith("[")) {
			try {
				items = JSON.parse(text);
			} catch {
				items = [];
			}
		} else {
			items = text.split(",");
		}
	}
	if (!Array.isArray(items)) return fallback;
	const names = items
		.filter((v): v is string => typeof v === "string")
		.map((v) => v.trim())
		.filter(Boolean);
	return names.length ? names : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const v = value.trim().toLowerCase();
		if (["true", "1", "yes", "on"].includes(v)) return true;
		if (["false", "0", "no", "off"].includes(v)) return false;
	}
	return fallback;
}

/** Build the effective configuration from Worker vars, falling back to DEFAULTS. */
export function resolveConfig(env: Env = {}): Config {
	const sessionCookieNames = list(env.SESSION_COOKIE_NAMES, DEFAULTS.sessionCookieNames);

	const min = Number(env.MIN_SESSION_COOKIES);
	const minSessionCookies =
		Number.isInteger(min) && min >= 1
			? Math.min(min, sessionCookieNames.length)
			: Math.min(DEFAULTS.minSessionCookies, sessionCookieNames.length);

	let signInUrl = str(env.SIGN_IN_URL, DEFAULTS.signInUrl);
	try {
		new URL(signInUrl);
	} catch {
		signInUrl = DEFAULTS.signInUrl;
	}

	return {
		targetHost: str(env.TARGET_HOST, DEFAULTS.targetHost).toLowerCase(),
		signInUrl,
		hostedDomain: str(env.HOSTED_DOMAIN, ""),
		sessionCookieNames,
		minSessionCookies,
		observeOnly: bool(env.OBSERVE_ONLY, DEFAULTS.observeOnly),
	};
}

/** Count how many known Google session cookies the request carries. */
export function countSessionCookies(
	cookieHeader: string | null,
	sessionCookieNames: readonly string[] = DEFAULTS.sessionCookieNames,
): number {
	if (!cookieHeader) return 0;
	const names = new Set<string>();
	for (const part of cookieHeader.split(";")) {
		const eq = part.indexOf("=");
		const name = (eq === -1 ? part : part.slice(0, eq)).trim();
		if (name) names.add(name);
	}
	let count = 0;
	for (const name of sessionCookieNames) {
		if (names.has(name)) count++;
	}
	return count;
}

/** True for a top-level HTML page load. Subresource requests pass through. */
export function isHtmlNavigation(request: Request): boolean {
	if (request.method !== "GET" && request.method !== "HEAD") return false;
	const mode = request.headers.get("sec-fetch-mode");
	const dest = request.headers.get("sec-fetch-dest");
	if (mode === "navigate" || dest === "document") return true;
	if (mode || dest) return false; // Modern browser, explicitly not a page load.
	return request.headers.get("accept")?.includes("text/html") ?? false;
}

/** Build the Google sign-in URL that returns the user to the original page. */
export function signInRedirectUrl(
	originalUrl: string,
	config: Pick<Config, "signInUrl" | "hostedDomain"> = DEFAULTS,
): string {
	const url = new URL(config.signInUrl);
	url.searchParams.set("continue", originalUrl);
	if (config.hostedDomain) url.searchParams.set("hd", config.hostedDomain);
	return url.toString();
}

export type Decision = "redirect" | "pass";

/** Decide what to do with a request. Pure, so it can be unit tested. */
export function decide(
	request: Request,
	config: Config,
): { navigation: boolean; sessionCookies: number; signedIn: boolean; action: Decision } {
	const navigation = isHtmlNavigation(request);
	const sessionCookies = countSessionCookies(
		request.headers.get("cookie"),
		config.sessionCookieNames,
	);
	const signedIn = sessionCookies >= config.minSessionCookies;
	const action: Decision =
		navigation && !signedIn && !config.observeOnly ? "redirect" : "pass";
	return { navigation, sessionCookies, signedIn, action };
}

export class GatewayMiddleware extends WorkerEntrypoint<Env> {
	async handle(
		request: Request,
		context: GatewayMiddlewareContext,
		next: GatewayMiddlewareNext,
	): Promise<Response> {
		const config = resolveConfig(this.env);
		if (context.host?.toLowerCase() !== config.targetHost) return next(request);

		const result = decide(request, config);

		console.log(
			JSON.stringify({
				event: "gemini-signin-gate",
				uri: context.uri,
				observeOnly: config.observeOnly,
				...result,
			}),
		);

		if (result.action === "redirect") {
			return new Response(null, {
				status: 302,
				headers: {
					location: signInRedirectUrl(request.url, config),
					"cache-control": "no-store",
					[MARKER_HEADER]: MARKER_VALUE,
				},
			});
		}

		const response = await next(request);
		const headers = new Headers(response.headers);
		headers.set(MARKER_HEADER, MARKER_VALUE);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}
}
