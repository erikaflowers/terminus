// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { getGlobalConfig, setGlobalConfig } from "@/app/store/agents";
import { getApi, pushCloudSyncNow } from "@/app/store/global";
import { getAtoms } from "@/app/store/global-atoms";
import type { WaveConfigViewModel } from "@/app/view/waveconfig/waveconfig-model";
import { useAtom, useAtomValue } from "jotai";
import { memo, useCallback, useEffect, useState } from "react";

interface SettingsSectionProps {
    title: string;
    children: React.ReactNode;
}

const SettingsSection = memo(({ title, children }: SettingsSectionProps) => {
    return (
        <div className="flex flex-col gap-1 mb-6">
            <h3 className="text-sm font-semibold text-secondary uppercase tracking-wider mb-2 px-1">{title}</h3>
            <div className="flex flex-col gap-3">{children}</div>
        </div>
    );
});
SettingsSection.displayName = "SettingsSection";

interface NumberSettingProps {
    label: string;
    description?: string;
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    suffix?: string;
}

const NumberSetting = memo(({ label, description, value, onChange, min, max, suffix }: NumberSettingProps) => {
    const handleChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const raw = e.target.value;
            if (raw === "") return;
            const num = parseInt(raw, 10);
            if (isNaN(num)) return;
            if (min != null && num < min) return;
            if (max != null && num > max) return;
            onChange(num);
        },
        [onChange, min, max]
    );

    return (
        <div className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-secondary/20 transition-colors">
            <div className="flex flex-col">
                <span className="text-sm font-medium">{label}</span>
                {description && <span className="text-xs text-muted mt-0.5">{description}</span>}
            </div>
            <div className="flex items-center gap-1.5">
                <input
                    type="number"
                    value={value}
                    onChange={handleChange}
                    min={min}
                    max={max}
                    className="w-16 px-2 py-1 text-sm text-right bg-background border border-border rounded focus:outline-none focus:border-accent"
                />
                {suffix && <span className="text-xs text-muted">{suffix}</span>}
            </div>
        </div>
    );
});
NumberSetting.displayName = "NumberSetting";

interface ColorSettingProps {
    label: string;
    description?: string;
    value: string;
    onChange: (value: string) => void;
}

const ColorSetting = memo(({ label, description, value, onChange }: ColorSettingProps) => {
    const handleTextChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            onChange(e.target.value);
        },
        [onChange]
    );

    return (
        <div className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-secondary/20 transition-colors">
            <div className="flex flex-col">
                <span className="text-sm font-medium">{label}</span>
                {description && <span className="text-xs text-muted mt-0.5">{description}</span>}
            </div>
            <div className="flex items-center gap-2">
                <div
                    className="w-6 h-6 rounded border border-border shrink-0"
                    style={{ backgroundColor: value || "transparent" }}
                />
                <input
                    type="text"
                    value={value}
                    onChange={handleTextChange}
                    placeholder="e.g. fuchsia, #ff00ff"
                    className="w-32 px-2 py-1 text-sm bg-background border border-border rounded focus:outline-none focus:border-accent"
                />
            </div>
        </div>
    );
});
ColorSetting.displayName = "ColorSetting";

type CloudAuthStatus = {
    loggedIn: boolean;
    email?: string;
    name?: string;
    picture?: string;
    syncEnabled?: boolean;
};

type DeviceInfo = {
    machine_id: string;
    device_name: string;
    os: string;
    last_sync_at: string;
    created_at: string;
};

const AccountSection = memo(() => {
    const [authStatus, setAuthStatus] = useState<CloudAuthStatus | null>(null);
    const [devices, setDevices] = useState<DeviceInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [showDevices, setShowDevices] = useState(false);
    const [lastSynced, setLastSynced] = useState<string | null>(null);

    const refreshStatus = useCallback(async () => {
        const status = await getApi().terminusAuthStatus();
        setAuthStatus(status);
        if (status.loggedIn) {
            const devResult = await getApi().terminusDevices();
            if (devResult.ok && devResult.devices) {
                setDevices(devResult.devices);
            }
        }
    }, []);

    useEffect(() => {
        refreshStatus();
    }, [refreshStatus]);

    const handleLogin = useCallback(async () => {
        setLoading(true);
        try {
            const result = await getApi().terminusAuthLogin();
            if (result.ok) {
                await refreshStatus();
                // After login: pull cloud configs (writes to disk via IPC handler)
                // If cloud is empty, seed it with local configs
                const pullResult = await getApi().terminusSyncPull();
                if (pullResult.ok) {
                    if (pullResult.updated_at) {
                        setLastSynced(pullResult.updated_at);
                    } else {
                        // Cloud is empty — push local configs to seed it
                        const pushResult = await pushCloudSyncNow();
                        if (pushResult?.ok) setLastSynced(pushResult.updated_at);
                    }
                }
            }
        } finally {
            setLoading(false);
        }
    }, [refreshStatus]);

    const handleLogout = useCallback(async () => {
        await getApi().terminusAuthLogout();
        setAuthStatus({ loggedIn: false });
        setDevices([]);
    }, []);

    const handleSyncToggle = useCallback(async () => {
        if (!authStatus) return;
        const newVal = !authStatus.syncEnabled;
        await getApi().terminusSyncToggle(newVal);
        setAuthStatus((prev) => (prev ? { ...prev, syncEnabled: newVal } : prev));
    }, [authStatus]);

    const handlePull = useCallback(async () => {
        setLoading(true);
        try {
            const result = await getApi().terminusSyncPull();
            if (result.ok && result.updated_at) {
                setLastSynced(result.updated_at);
            }
        } finally {
            setLoading(false);
        }
    }, []);

    const handlePush = useCallback(async () => {
        setLoading(true);
        try {
            const result = await pushCloudSyncNow();
            if (result?.ok && result.updated_at) setLastSynced(result.updated_at);
        } finally {
            setLoading(false);
        }
    }, []);

    if (authStatus === null) {
        return (
            <SettingsSection title="Account">
                <div className="px-3 py-2 text-sm text-muted">Loading...</div>
            </SettingsSection>
        );
    }

    if (!authStatus.loggedIn) {
        return (
            <SettingsSection title="Account">
                <div className="px-3 py-3 flex flex-col gap-2">
                    <span className="text-sm text-muted">Sync preferences across your machines</span>
                    <button
                        onClick={handleLogin}
                        disabled={loading}
                        className="self-start px-4 py-2 text-sm font-medium rounded-md transition-colors"
                        style={{
                            backgroundColor: loading ? "#555" : "#ff00ff",
                            color: "white",
                            border: "none",
                            cursor: loading ? "wait" : "pointer",
                            opacity: loading ? 0.7 : 1,
                        }}
                    >
                        {loading ? "Signing in..." : "Sign in with Google"}
                    </button>
                </div>
            </SettingsSection>
        );
    }

    return (
        <SettingsSection title="Account">
            <div className="px-3 py-2 flex items-center gap-3">
                {authStatus.picture && (
                    <img
                        src={authStatus.picture}
                        alt=""
                        className="w-8 h-8 rounded-full"
                        referrerPolicy="no-referrer"
                    />
                )}
                <div className="flex flex-col">
                    <span className="text-sm font-medium">{authStatus.name || authStatus.email}</span>
                    {authStatus.name && (
                        <span className="text-xs text-muted">{authStatus.email}</span>
                    )}
                </div>
            </div>
            <div className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-secondary/20 transition-colors">
                <div className="flex flex-col">
                    <span className="text-sm font-medium">Sync Preferences</span>
                    <span className="text-xs text-muted">Auto-sync settings across machines</span>
                </div>
                <button
                    onClick={handleSyncToggle}
                    className="relative w-10 h-5 rounded-full transition-colors"
                    style={{
                        backgroundColor: authStatus.syncEnabled ? "#ff00ff" : "#555",
                        border: "none",
                        cursor: "pointer",
                    }}
                >
                    <span
                        className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform"
                        style={{
                            left: authStatus.syncEnabled ? "calc(100% - 18px)" : "2px",
                        }}
                    />
                </button>
            </div>
            <div className="flex items-center gap-2 px-3 py-1">
                <button
                    onClick={handlePull}
                    disabled={loading}
                    className="px-3 py-1 text-xs rounded transition-colors"
                    style={{
                        backgroundColor: "#333",
                        color: "#ccc",
                        border: "1px solid #555",
                        cursor: loading ? "wait" : "pointer",
                    }}
                >
                    {loading ? "Pulling..." : "↓ Pull from Cloud"}
                </button>
                <button
                    onClick={handlePush}
                    disabled={loading}
                    className="px-3 py-1 text-xs rounded transition-colors"
                    style={{
                        backgroundColor: "#333",
                        color: "#ccc",
                        border: "1px solid #555",
                        cursor: loading ? "wait" : "pointer",
                    }}
                >
                    {loading ? "Pushing..." : "↑ Push to Cloud"}
                </button>
                {lastSynced && (
                    <span className="text-xs text-muted">
                        Last synced: {new Date(lastSynced).toLocaleTimeString()}
                    </span>
                )}
            </div>
            {devices.length > 0 && (
                <div className="px-3 py-1">
                    <button
                        onClick={() => setShowDevices(!showDevices)}
                        className="text-xs text-muted hover:text-foreground transition-colors"
                        style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
                    >
                        {showDevices ? "Hide" : "Show"} Connected Devices ({devices.length})
                    </button>
                    {showDevices && (
                        <div className="flex flex-col gap-1 mt-2">
                            {devices.map((d) => (
                                <div
                                    key={d.machine_id}
                                    className="flex items-center justify-between text-xs px-2 py-1 rounded"
                                    style={{ backgroundColor: "rgba(255,255,255,0.03)" }}
                                >
                                    <span>{d.device_name || d.machine_id.slice(0, 8)}</span>
                                    <span className="text-muted">
                                        {d.os} &middot;{" "}
                                        {d.last_sync_at
                                            ? new Date(d.last_sync_at).toLocaleDateString()
                                            : "never synced"}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
            <div className="px-3 py-1">
                <button
                    onClick={handleLogout}
                    className="text-xs text-muted hover:text-red-400 transition-colors"
                    style={{ background: "none", border: "none", cursor: "pointer", padding: 0 }}
                >
                    Sign Out
                </button>
            </div>
        </SettingsSection>
    );
});
AccountSection.displayName = "AccountSection";

interface SecretSettingProps {
    label: string;
    description?: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
}

const SecretSetting = memo(({ label, description, value, onChange, placeholder }: SecretSettingProps) => {
    const [localValue, setLocalValue] = useState(value || "");
    const [revealed, setRevealed] = useState(false);

    useEffect(() => {
        setLocalValue(value || "");
    }, [value]);

    const handleSave = useCallback(() => {
        const trimmed = localValue.trim();
        if (trimmed !== (value || "")) {
            onChange(trimmed);
        }
    }, [localValue, value, onChange]);

    const maskedDisplay = localValue
        ? localValue.slice(0, 7) + "..." + localValue.slice(-4)
        : "";

    return (
        <div className="flex flex-col gap-1.5 px-3 py-2 rounded-md hover:bg-secondary/20 transition-colors">
            <div className="flex flex-col">
                <span className="text-sm font-medium">{label}</span>
                {description && <span className="text-xs text-muted mt-0.5">{description}</span>}
            </div>
            <div className="flex items-center gap-2">
                {revealed ? (
                    <input
                        type="text"
                        value={localValue}
                        onChange={(e) => setLocalValue(e.target.value)}
                        onBlur={handleSave}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") {
                                handleSave();
                                (e.target as HTMLInputElement).blur();
                            }
                        }}
                        placeholder={placeholder}
                        className="flex-1 px-2 py-1 text-sm bg-background border border-border rounded focus:outline-none focus:border-accent"
                        style={{ fontFamily: "monospace", minWidth: 0 }}
                    />
                ) : (
                    <span
                        className="flex-1 px-2 py-1 text-sm rounded"
                        style={{
                            fontFamily: "monospace",
                            color: localValue ? "var(--main-text-color)" : "#666",
                            backgroundColor: "rgba(0,0,0,0.2)",
                            minWidth: 0,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        }}
                    >
                        {localValue ? maskedDisplay : "Not set"}
                    </span>
                )}
                <button
                    onClick={() => setRevealed((v) => !v)}
                    className="px-2 py-1 text-xs rounded transition-colors"
                    style={{
                        backgroundColor: "rgba(255,255,255,0.05)",
                        color: "#888",
                        border: "1px solid rgba(255,255,255,0.1)",
                        cursor: "pointer",
                        flexShrink: 0,
                    }}
                >
                    {revealed ? "Hide" : "Edit"}
                </button>
            </div>
        </div>
    );
});
SecretSetting.displayName = "SecretSetting";

interface TextSettingProps {
    label: string;
    description?: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
}

const TextSetting = memo(({ label, description, value, onChange, placeholder }: TextSettingProps) => {
    const [localValue, setLocalValue] = useState(value || "");

    useEffect(() => {
        setLocalValue(value || "");
    }, [value]);

    const handleSave = useCallback(() => {
        const trimmed = localValue.trim();
        if (trimmed !== (value || "")) {
            onChange(trimmed || null);
        }
    }, [localValue, value, onChange]);

    return (
        <div className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-secondary/20 transition-colors">
            <div className="flex flex-col">
                <span className="text-sm font-medium">{label}</span>
                {description && <span className="text-xs text-muted mt-0.5">{description}</span>}
            </div>
            <input
                type="text"
                value={localValue}
                onChange={(e) => setLocalValue(e.target.value)}
                onBlur={handleSave}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        handleSave();
                        (e.target as HTMLInputElement).blur();
                    }
                }}
                placeholder={placeholder}
                className="w-48 px-2 py-1 text-sm bg-background border border-border rounded focus:outline-none focus:border-accent"
            />
        </div>
    );
});
TextSetting.displayName = "TextSetting";

interface PathSettingProps {
    label: string;
    description?: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
}

const PathSetting = memo(({ label, description, value, onChange, placeholder }: PathSettingProps) => {
    const [localValue, setLocalValue] = useState(value || "");

    useEffect(() => {
        setLocalValue(value || "");
    }, [value]);

    const handleSave = useCallback(() => {
        const trimmed = localValue.trim();
        if (trimmed !== (value || "")) {
            onChange(trimmed || null);
        }
    }, [localValue, value, onChange]);

    const handleBrowse = useCallback(async () => {
        const picked = await getApi().pickDirectory(label);
        if (picked) {
            setLocalValue(picked);
            onChange(picked);
        }
    }, [label, onChange]);

    return (
        <div className="flex items-center justify-between px-3 py-2 rounded-md hover:bg-secondary/20 transition-colors">
            <div className="flex flex-col">
                <span className="text-sm font-medium">{label}</span>
                {description && <span className="text-xs text-muted mt-0.5">{description}</span>}
            </div>
            <div className="flex items-center gap-1.5">
                <input
                    type="text"
                    value={localValue}
                    onChange={(e) => setLocalValue(e.target.value)}
                    onBlur={handleSave}
                    onKeyDown={(e) => {
                        if (e.key === "Enter") {
                            handleSave();
                            (e.target as HTMLInputElement).blur();
                        }
                    }}
                    placeholder={placeholder}
                    className="w-48 px-2 py-1 text-sm bg-background border border-border rounded focus:outline-none focus:border-accent"
                />
                <button
                    onClick={handleBrowse}
                    className="px-2 py-1 text-xs rounded transition-colors"
                    style={{
                        backgroundColor: "rgba(255,255,255,0.05)",
                        color: "#888",
                        border: "1px solid rgba(255,255,255,0.1)",
                        cursor: "pointer",
                        flexShrink: 0,
                    }}
                    title="Browse..."
                >
                    <i className="fa-sharp fa-solid fa-folder-open" />
                </button>
            </div>
        </div>
    );
});
PathSetting.displayName = "PathSetting";

const TerminusSection = memo(() => {
    const [config, setConfig] = useState(() => getGlobalConfig());

    const updateField = useCallback((key: string, value: string) => {
        const trimmed = value.trim();
        const val = trimmed || null;
        setGlobalConfig({ [key]: val });
        setConfig((prev) => ({ ...prev, [key]: val }));
    }, []);

    return (
        <SettingsSection title="Terminus">
            <PathSetting
                label="Repo Base Path"
                description="Root directory containing your project repos"
                value={config.repoBasePath ?? ""}
                onChange={(v) => updateField("repoBasePath", v)}
                placeholder="/Users/you/projects"
            />
            <PathSetting
                label="Agents Path"
                description="Root path to the agents repo (for avatars, crew)"
                value={config.agentsPath ?? ""}
                onChange={(v) => updateField("agentsPath", v)}
                placeholder="/Users/you/projects/agents"
            />
            <TextSetting
                label="GitHub Org / User"
                description="GitHub username or org for commit links"
                value={config.githubOrg ?? ""}
                onChange={(v) => updateField("githubOrg", v)}
                placeholder="myusername"
            />
            <SecretSetting
                label="Plausible API Key"
                description="Bearer token for Plausible analytics"
                value={config.plausibleApiKey ?? ""}
                onChange={(v) => updateField("plausibleApiKey", v)}
                placeholder="your-api-key"
            />
            <TextSetting
                label="Plausible Site ID"
                description="Domain tracked in Plausible"
                value={config.plausibleSiteId ?? ""}
                onChange={(v) => updateField("plausibleSiteId", v)}
                placeholder="example.com"
            />
            <div style={{ borderTop: "1px solid rgba(255,255,255,0.06)", margin: "8px 0" }} />
            <TextSetting
                label="Cloud Sync URL"
                description="API endpoint for pushing/pulling synced settings"
                value={config.cloudSyncUrl ?? ""}
                onChange={(v) => updateField("cloudSyncUrl", v)}
                placeholder="https://yourapi.com/api/terminus/sync"
            />
            <TextSetting
                label="Cloud Devices URL"
                description="API endpoint for listing synced devices"
                value={config.cloudDevicesUrl ?? ""}
                onChange={(v) => updateField("cloudDevicesUrl", v)}
                placeholder="https://yourapi.com/api/terminus/devices"
            />
            <SecretSetting
                label="Cloud OAuth Client ID"
                description="Google OAuth client ID for cloud sync login"
                value={config.cloudOAuthClientId ?? ""}
                onChange={(v) => updateField("cloudOAuthClientId", v)}
                placeholder="your-client-id.apps.googleusercontent.com"
            />
            <SecretSetting
                label="Cloud OAuth Client Secret"
                description="Google OAuth client secret for cloud sync login"
                value={config.cloudOAuthClientSecret ?? ""}
                onChange={(v) => updateField("cloudOAuthClientSecret", v)}
                placeholder="your-client-secret"
            />
        </SettingsSection>
    );
});
TerminusSection.displayName = "TerminusSection";

const SettingsVisualContent = memo(({ model }: { model: WaveConfigViewModel }) => {
    const [fileContent, setFileContent] = useAtom(model.fileContentAtom);
    const liveSettings = useAtomValue(getAtoms().settingsAtom);

    const updateSetting = useCallback(
        (key: string, value: any) => {
            const current = (() => {
                try {
                    return JSON.parse(fileContent || "{}");
                } catch {
                    return {};
                }
            })();
            current[key] = value;
            const updated = JSON.stringify(current, null, 2);
            setFileContent(updated);
            model.markAsEdited();
            model.saveFile();
        },
        [fileContent, setFileContent, model]
    );

    return (
        <div className="flex flex-col p-6 overflow-y-auto h-full">
            <AccountSection />
            <TerminusSection />
            {/* AI section hidden until Terminus has an in-app AI plan
            <SettingsSection title="AI">
                <SecretSetting
                    label="API Token"
                    description="Anthropic, OpenAI, or other provider API key"
                    value={liveSettings["ai:apitoken"] ?? ""}
                    onChange={(v) => updateSetting("ai:apitoken", v)}
                    placeholder="sk-ant-..."
                />
                <TextSetting
                    label="Model"
                    description="e.g. claude-sonnet-4-5-20250514, gpt-4o"
                    value={liveSettings["ai:model"] ?? ""}
                    onChange={(v) => updateSetting("ai:model", v)}
                    placeholder="claude-sonnet-4-5-20250514"
                />
                <TextSetting
                    label="Base URL"
                    description="Custom endpoint (leave empty for default)"
                    value={liveSettings["ai:baseurl"] ?? ""}
                    onChange={(v) => updateSetting("ai:baseurl", v)}
                    placeholder="https://api.anthropic.com"
                />
            </SettingsSection>
            */}
            <SettingsSection title="Layout">
                <NumberSetting
                    label="Pane Gap Size"
                    description="Space between panes (total gap in pixels)"
                    value={liveSettings["window:tilegapsize"] ?? 16}
                    onChange={(v) => updateSetting("window:tilegapsize", v)}
                    min={0}
                    max={64}
                    suffix="px"
                />
                <NumberSetting
                    label="Active Pane Border Width"
                    description="Thickness of the focused pane highlight"
                    value={liveSettings["window:activeborderwidth"] ?? 4}
                    onChange={(v) => updateSetting("window:activeborderwidth", v)}
                    min={0}
                    max={16}
                    suffix="px"
                />
                <ColorSetting
                    label="Active Pane Border Color"
                    description="Color of the focused pane highlight"
                    value={liveSettings["window:activebordercolor"] ?? "fuchsia"}
                    onChange={(v) => updateSetting("window:activebordercolor", v)}
                />
            </SettingsSection>
            <SettingsSection title="Terminal">
                <NumberSetting
                    label="Default Font Size"
                    description="Global default for all terminal panes (per-pane overrides still apply)"
                    value={liveSettings["term:fontsize"] ?? 12}
                    onChange={(v) => updateSetting("term:fontsize", v)}
                    min={4}
                    max={64}
                    suffix="px"
                />
            </SettingsSection>
        </div>
    );
});
SettingsVisualContent.displayName = "SettingsVisualContent";

export { SettingsVisualContent };
