// Terminus Cloud Sync — Google OAuth for Electron
// Handles Google OAuth login via BrowserWindow popup + loopback redirect

import * as electron from "electron";
import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { getWaveConfigDir } from "./emain-platform";
import { focusedWaveWindow } from "./emain-window";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Read cloud sync config from agent-preferences.json _global key.
 * All cloud sync endpoints and OAuth credentials are user preferences — not hardcoded.
 */
function loadCloudSyncConfig(): { syncUrl: string; devicesUrl: string; clientId: string; clientSecret: string } {
    const prefsPath = path.join(getWaveConfigDir(), "agent-preferences.json");
    try {
        const raw = fs.readFileSync(prefsPath, "utf-8");
        const prefs = JSON.parse(raw);
        const global = prefs["_global"] ?? {};
        return {
            syncUrl: global["cloudSyncUrl"] ?? "",
            devicesUrl: global["cloudDevicesUrl"] ?? "",
            clientId: global["cloudOAuthClientId"] ?? "",
            clientSecret: global["cloudOAuthClientSecret"] ?? "",
        };
    } catch {
        return { syncUrl: "", devicesUrl: "", clientId: "", clientSecret: "" };
    }
}

// Backward compat — loads from prefs now, falls back to file for migration
function loadOAuthCredentials(): { clientId: string; clientSecret: string } {
    const config = loadCloudSyncConfig();
    if (config.clientId && config.clientSecret) {
        return { clientId: config.clientId, clientSecret: config.clientSecret };
    }
    // Fallback: try legacy oauth-credentials.json file
    const credPath = path.join(getWaveConfigDir(), "oauth-credentials.json");
    try {
        const raw = fs.readFileSync(credPath, "utf-8");
        const creds = JSON.parse(raw);
        return { clientId: creds.client_id, clientSecret: creds.client_secret };
    } catch {
        throw new Error("Cloud sync not configured. Set OAuth Client ID and Secret in Settings → Terminus.");
    }
}

function getCloudSyncUrl(): string {
    return loadCloudSyncConfig().syncUrl;
}

function getCloudDevicesUrl(): string {
    return loadCloudSyncConfig().devicesUrl;
}

export type AuthState = {
    email: string;
    name: string;
    picture: string;
    id_token: string;
    access_token: string;
    refresh_token?: string;
    token_expiry: number;
    sync_enabled: boolean;
};

function getAuthFilePath(): string {
    return path.join(getWaveConfigDir(), "auth.json");
}

export function readAuthState(): AuthState | null {
    try {
        const raw = fs.readFileSync(getAuthFilePath(), "utf-8");
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

export function writeAuthState(state: AuthState): void {
    fs.writeFileSync(getAuthFilePath(), JSON.stringify(state, null, 2), "utf-8");
}

export function clearAuthState(): void {
    try {
        fs.unlinkSync(getAuthFilePath());
    } catch {
        // file didn't exist, that's fine
    }
}

function decodeJwtPayload(token: string): any {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT");
    const payload = parts[1];
    // Base64url decode
    const padded = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(padded, "base64").toString("utf-8");
    return JSON.parse(decoded);
}

/**
 * Use stored refresh_token to get fresh id_token + access_token from Google.
 * Updates auth.json on success. Returns the updated AuthState.
 */
export async function refreshTokenIfNeeded(auth: AuthState): Promise<AuthState> {
    // 5-minute buffer before expiry
    if (auth.token_expiry > Date.now() + 5 * 60 * 1000) {
        return auth; // still valid
    }
    if (!auth.refresh_token) {
        throw new Error("Token expired and no refresh_token available. Please sign in again.");
    }
    const creds = loadOAuthCredentials();
    const postData = new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: auth.refresh_token,
        grant_type: "refresh_token",
    }).toString();

    const tokens = await new Promise<{ id_token: string; access_token: string; expires_in: number }>((resolve, reject) => {
        const url = new URL(GOOGLE_TOKEN_URL);
        const options: https.RequestOptions = {
            hostname: url.hostname,
            path: url.pathname,
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(postData),
            },
        };
        const req = https.request(options, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Token refresh failed (${res.statusCode}): ${body}`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error(`Failed to parse refresh response: ${body}`));
                }
            });
        });
        req.on("error", reject);
        req.write(postData);
        req.end();
    });

    // Google doesn't return a new refresh_token on refresh — keep the existing one
    const jwt = decodeJwtPayload(tokens.id_token);
    const updated: AuthState = {
        ...auth,
        email: jwt.email,
        name: jwt.name || jwt.email,
        picture: jwt.picture || auth.picture,
        id_token: tokens.id_token,
        access_token: tokens.access_token,
        token_expiry: Date.now() + tokens.expires_in * 1000,
    };
    writeAuthState(updated);
    console.log("cloud sync: refreshed expired token");
    return updated;
}

/**
 * Exchange authorization code for tokens via Google's token endpoint.
 * Uses Node's built-in https module to avoid adding dependencies.
 */
function exchangeCodeForTokens(
    code: string,
    redirectUri: string
): Promise<{ id_token: string; access_token: string; refresh_token?: string; expires_in: number }> {
    return new Promise((resolve, reject) => {
        const creds = loadOAuthCredentials();
        const postData = new URLSearchParams({
            code,
            client_id: creds.clientId,
            client_secret: creds.clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
        }).toString();

        const url = new URL(GOOGLE_TOKEN_URL);
        const options: https.RequestOptions = {
            hostname: url.hostname,
            path: url.pathname,
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Content-Length": Buffer.byteLength(postData),
            },
        };

        const req = https.request(options, (res) => {
            let body = "";
            res.on("data", (chunk) => (body += chunk));
            res.on("end", () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Token exchange failed (${res.statusCode}): ${body}`));
                    return;
                }
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    reject(new Error(`Failed to parse token response: ${body}`));
                }
            });
        });
        req.on("error", reject);
        req.write(postData);
        req.end();
    });
}

/**
 * Start Google OAuth flow:
 * 1. Spin up a temporary HTTP server on an ephemeral port
 * 2. Open a BrowserWindow with Google's consent screen
 * 3. Catch the redirect with the authorization code
 * 4. Exchange code for tokens
 * 5. Store auth state in auth.json
 */
export async function startOAuthLogin(): Promise<AuthState> {
    return new Promise((resolve, reject) => {
        let authWindow: electron.BrowserWindow | null = null;
        let server: http.Server | null = null;
        let settled = false;

        function cleanup() {
            if (authWindow && !authWindow.isDestroyed()) {
                authWindow.close();
            }
            authWindow = null;
            if (server) {
                server.close();
                server = null;
            }
        }

        function settle(err: Error | null, result?: AuthState) {
            if (settled) return;
            settled = true;
            cleanup();
            if (err) {
                reject(err);
            } else {
                resolve(result!);
            }
        }

        // Create a temporary HTTP server to catch the OAuth redirect
        server = http.createServer(async (req, res) => {
            const reqUrl = new URL(req.url!, `http://127.0.0.1`);
            if (reqUrl.pathname !== "/callback") {
                res.writeHead(404);
                res.end("Not found");
                return;
            }

            const code = reqUrl.searchParams.get("code");
            const error = reqUrl.searchParams.get("error");

            if (error) {
                res.writeHead(200, { "Content-Type": "text/html" });
                res.end("<html><body><h2>Login cancelled</h2><p>You can close this window.</p><script>window.close()</script></body></html>");
                settle(new Error(`OAuth error: ${error}`));
                return;
            }

            if (!code) {
                res.writeHead(400, { "Content-Type": "text/html" });
                res.end("<html><body><h2>Missing authorization code</h2></body></html>");
                settle(new Error("No authorization code received"));
                return;
            }

            // Show a nice success page immediately
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`<html><body style="font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #1a1a2e; color: #e0e0e0;">
                <div style="text-align: center;">
                    <h2 style="color: #ff00ff;">Signed in to Terminus</h2>
                    <p>You can close this window.</p>
                </div>
                <script>setTimeout(() => window.close(), 1500)</script>
            </body></html>`);

            try {
                const port = (server!.address() as any).port;
                const redirectUri = `http://127.0.0.1:${port}/callback`;
                const tokens = await exchangeCodeForTokens(code, redirectUri);
                const jwt = decodeJwtPayload(tokens.id_token);

                const authState: AuthState = {
                    email: jwt.email,
                    name: jwt.name || jwt.email,
                    picture: jwt.picture || "",
                    id_token: tokens.id_token,
                    access_token: tokens.access_token,
                    refresh_token: tokens.refresh_token,
                    token_expiry: Date.now() + tokens.expires_in * 1000,
                    sync_enabled: true,
                };

                writeAuthState(authState);
                settle(null, authState);
            } catch (e) {
                settle(e as Error);
            }
        });

        server.listen(0, "127.0.0.1", () => {
            const port = (server!.address() as any).port;
            const redirectUri = `http://127.0.0.1:${port}/callback`;

            // Build Google OAuth URL
            const state = crypto.randomBytes(16).toString("hex");
            const oauthCreds = loadOAuthCredentials();
            const params = new URLSearchParams({
                client_id: oauthCreds.clientId,
                redirect_uri: redirectUri,
                response_type: "code",
                scope: "email profile",
                access_type: "offline",
                prompt: "consent",
                state,
            });

            const authUrl = `${GOOGLE_AUTH_URL}?${params.toString()}`;

            // Create the popup window
            const parentWindow = focusedWaveWindow;
            authWindow = new electron.BrowserWindow({
                width: 500,
                height: 700,
                parent: parentWindow || undefined,
                modal: false,
                show: true,
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                },
                title: "Sign in — Terminus",
                backgroundColor: "#1a1a2e",
            });

            authWindow.loadURL(authUrl);

            // If user closes the window before completing auth
            authWindow.on("closed", () => {
                authWindow = null;
                settle(new Error("Login window closed by user"));
            });
        });

        server.on("error", (err) => {
            settle(err);
        });
    });
}

/**
 * Make an authenticated request to the Kestris sync API.
 */
function kestrisRequest(
    url: string,
    method: string,
    token: string,
    body?: any
): Promise<any> {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const postData = body ? JSON.stringify(body) : null;

        const options: https.RequestOptions = {
            hostname: parsedUrl.hostname,
            path: parsedUrl.pathname + parsedUrl.search,
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                ...(postData ? { "Content-Length": Buffer.byteLength(postData) } : {}),
            },
        };

        const req = https.request(options, (res) => {
            let responseBody = "";
            res.on("data", (chunk) => (responseBody += chunk));
            res.on("end", () => {
                if (res.statusCode! < 200 || res.statusCode! >= 300) {
                    reject(new Error(`Kestris API error (${res.statusCode}): ${responseBody}`));
                    return;
                }
                try {
                    resolve(JSON.parse(responseBody));
                } catch {
                    resolve(responseBody);
                }
            });
        });
        req.on("error", reject);
        if (postData) req.write(postData);
        req.end();
    });
}

/**
 * Pull all synced configs from cloud.
 */
export async function pullConfigs(auth: AuthState, machineId: string): Promise<{
    configs: Record<string, any>;
    devices: any[];
    updated_at: string | null;
}> {
    const syncUrl = getCloudSyncUrl();
    if (!syncUrl) {
        throw new Error("Cloud sync URL not configured. Set it in Settings → Terminus.");
    }
    const hostname = os.hostname();
    const platform = process.platform;
    const params = new URLSearchParams({
        machine_id: machineId,
        device_name: hostname,
        os: platform,
    });
    const url = `${syncUrl}?${params.toString()}`;
    return kestrisRequest(url, "GET", auth.id_token);
}

/**
 * Push local configs to cloud.
 */
export async function pushConfigs(
    auth: AuthState,
    machineId: string,
    configs: Record<string, any>
): Promise<{ ok: boolean; updated_at: string }> {
    const syncUrl = getCloudSyncUrl();
    if (!syncUrl) {
        throw new Error("Cloud sync URL not configured. Set it in Settings → Terminus.");
    }
    const hostname = os.hostname();
    const platform = process.platform;
    return kestrisRequest(syncUrl, "POST", auth.id_token, {
        configs,
        machine_id: machineId,
        device_name: hostname,
        os: platform,
    });
}

/**
 * Get list of registered devices from cloud.
 */
export async function getDevices(auth: AuthState): Promise<{ devices: any[] }> {
    const devicesUrl = getCloudDevicesUrl();
    if (!devicesUrl) {
        throw new Error("Cloud devices URL not configured. Set it in Settings → Terminus.");
    }
    return kestrisRequest(devicesUrl, "GET", auth.id_token);
}

// ── Shared pull/push logic (used by the IPC handlers and the startup pull) ──

// Config files that are synced. Must match SYNC_CONFIG_KEYS in frontend/app/store/global.ts.
// agent-preferences.json is deliberately NOT synced: it holds the OAuth client secret.
export const SYNC_CONFIG_KEYS = ["settings", "connections", "widgets"];

// Secret-bearing keys (e.g. "ai:apitoken") never leave this machine and are never
// overwritten by a pull. Keep in sync with isSecretConfigKey in frontend/app/store/global.ts.
// "token(?!s)" so non-secret keys like "ai:maxtokens" still sync.
const SECRET_KEY_RE = /apitoken|apikey|api_key|secret|password|token(?!s)/i;

// Canonical content of each key as last pulled from / pushed to the cloud (secrets stripped).
// Used to skip echo pushes (a pull triggers a config event, which triggers a push) and
// duplicate pushes from multiple tabs.
const lastSyncedContent = new Map<string, string>();
let lastSyncedAt: string | null = null;

function isPlainObject(v: any): boolean {
    return v != null && typeof v === "object" && !Array.isArray(v);
}

export function stripSecretConfigKeys(data: any): any {
    if (Array.isArray(data)) {
        return data.map(stripSecretConfigKeys);
    }
    if (!isPlainObject(data)) {
        return data;
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(data)) {
        if (SECRET_KEY_RE.test(k)) continue;
        out[k] = stripSecretConfigKeys(v);
    }
    return out;
}

// copy local secret-bearing keys back into pulled (secret-free) data so a pull never wipes them
function restoreLocalSecrets(pulled: any, local: any): any {
    if (!isPlainObject(pulled) || !isPlainObject(local)) {
        return pulled;
    }
    for (const [k, v] of Object.entries(local)) {
        if (SECRET_KEY_RE.test(k)) {
            pulled[k] = v;
        } else if (isPlainObject(pulled[k]) && isPlainObject(v)) {
            restoreLocalSecrets(pulled[k], v);
        }
    }
    return pulled;
}

function stableStringify(v: any): string {
    if (Array.isArray(v)) {
        return "[" + v.map(stableStringify).join(",") + "]";
    }
    if (isPlainObject(v)) {
        const keys = Object.keys(v).sort();
        return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(v[k])).join(",") + "}";
    }
    return JSON.stringify(v) ?? "null";
}

// Returns the on-disk path for a sync key, or null if the key is not allowlisted
// or would resolve outside the config dir.
function resolveSyncConfigPath(configDir: string, key: string): string | null {
    if (!SYNC_CONFIG_KEYS.includes(key)) {
        return null;
    }
    const baseDir = path.resolve(configDir);
    const filePath = path.resolve(baseDir, `${key}.json`);
    if (path.dirname(filePath) !== baseDir) {
        return null;
    }
    return filePath;
}

/**
 * Pull configs from the cloud and write the allowlisted ones into the config dir
 * (the filewatcher picks them up). With skipNewerLocal, a local file modified after
 * the cloud's updated_at is left alone (startup pull); manual pulls overwrite.
 */
export async function pullAndWriteConfigs(
    auth: AuthState,
    machineId: string,
    opts: { skipNewerLocal: boolean }
): Promise<{
    configs: Record<string, any>;
    devices: any[];
    updated_at: string | null;
    written: string[];
    skipped: string[];
}> {
    const result = await pullConfigs(auth, machineId);
    const configDir = getWaveConfigDir();
    const cloudTime = result.updated_at ? Date.parse(result.updated_at) : NaN;
    const written: string[] = [];
    const skipped: string[] = [];
    if (isPlainObject(result.configs)) {
        for (const [key, data] of Object.entries(result.configs)) {
            if (!isPlainObject(data)) continue;
            const filePath = resolveSyncConfigPath(configDir, key);
            if (filePath == null) {
                console.log("cloud sync: ignoring non-allowlisted config key from server:", JSON.stringify(key));
                continue;
            }
            let localMtime = 0;
            let localData: any = null;
            try {
                localMtime = fs.statSync(filePath).mtimeMs;
                localData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
            } catch {
                // missing or invalid local file
            }
            if (opts.skipNewerLocal && localMtime > 0 && (isNaN(cloudTime) || localMtime > cloudTime)) {
                skipped.push(key);
                continue;
            }
            const cloudData = stripSecretConfigKeys(data);
            const toWrite = restoreLocalSecrets(stripSecretConfigKeys(data), localData);
            fs.writeFileSync(filePath, JSON.stringify(toWrite, null, 2), "utf-8");
            lastSyncedContent.set(key, stableStringify(cloudData));
            written.push(key);
        }
    }
    if (result.updated_at) {
        lastSyncedAt = result.updated_at;
    }
    if (skipped.length > 0) {
        console.log("cloud sync: kept newer local configs (not overwritten):", skipped.join(", "));
    }
    return { ...result, written, skipped };
}

/**
 * Push allowlisted configs (secrets stripped) to the cloud. Skips the request when the
 * content matches what was last pulled or pushed.
 */
export async function pushSyncedConfigs(
    auth: AuthState,
    machineId: string,
    configs: Record<string, any>
): Promise<{ ok: boolean; updated_at: string; skipped?: boolean }> {
    const toPush: Record<string, any> = {};
    const content = new Map<string, string>();
    let changed = false;
    for (const [key, data] of Object.entries(configs ?? {})) {
        if (!SYNC_CONFIG_KEYS.includes(key) || !isPlainObject(data)) continue;
        toPush[key] = stripSecretConfigKeys(data);
        content.set(key, stableStringify(toPush[key]));
        if (lastSyncedContent.get(key) !== content.get(key)) {
            changed = true;
        }
    }
    if (!changed) {
        return { ok: true, updated_at: lastSyncedAt, skipped: true };
    }
    // record optimistically so concurrent pushes from other tabs are skipped; roll back on failure
    const prevContent = new Map(lastSyncedContent);
    for (const [key, s] of content) {
        lastSyncedContent.set(key, s);
    }
    try {
        const result = await pushConfigs(auth, machineId, toPush);
        if (result?.updated_at) {
            lastSyncedAt = result.updated_at;
        }
        return result;
    } catch (e) {
        lastSyncedContent.clear();
        for (const [key, s] of prevContent) {
            lastSyncedContent.set(key, s);
        }
        throw e;
    }
}
