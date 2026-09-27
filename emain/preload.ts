// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { contextBridge, ipcRenderer, Rectangle, WebviewTag } from "electron";

// update type in custom.d.ts (ElectronApi type)
contextBridge.exposeInMainWorld("api", {
    getAuthKey: () => ipcRenderer.sendSync("get-auth-key"),
    getIsDev: () => ipcRenderer.sendSync("get-is-dev"),
    getPlatform: () => ipcRenderer.sendSync("get-platform"),
    getCursorPoint: () => ipcRenderer.sendSync("get-cursor-point"),
    getUserName: () => ipcRenderer.sendSync("get-user-name"),
    getHostName: () => ipcRenderer.sendSync("get-host-name"),
    getDataDir: () => ipcRenderer.sendSync("get-data-dir"),
    getConfigDir: () => ipcRenderer.sendSync("get-config-dir"),
    getHomeDir: () => ipcRenderer.sendSync("get-home-dir"),
    getAboutModalDetails: () => ipcRenderer.sendSync("get-about-modal-details"),
    getWebviewPreload: () => ipcRenderer.sendSync("get-webview-preload"),
    getZoomFactor: () => ipcRenderer.sendSync("get-zoom-factor"),
    openNewWindow: () => ipcRenderer.send("open-new-window"),
    showWorkspaceAppMenu: (workspaceId) => ipcRenderer.send("workspace-appmenu-show", workspaceId),
    showBuilderAppMenu: (builderId) => ipcRenderer.send("builder-appmenu-show", builderId),
    showContextMenu: (workspaceId, menu) => ipcRenderer.send("contextmenu-show", workspaceId, menu),
    onContextMenuClick: (callback: (id: string | null) => void) =>
        ipcRenderer.on("contextmenu-click", (_event, id: string | null) => callback(id)),
    downloadFile: (filePath) => ipcRenderer.send("download", { filePath }),
    openExternal: (url) => {
        if (url && typeof url === "string") {
            ipcRenderer.send("open-external", url);
        } else {
            console.error("Invalid URL passed to openExternal:", url);
        }
    },
    getEnv: (varName) => ipcRenderer.sendSync("get-env", varName),
    onFullScreenChange: (callback) =>
        ipcRenderer.on("fullscreen-change", (_event, isFullScreen) => callback(isFullScreen)),
    onZoomFactorChange: (callback) =>
        ipcRenderer.on("zoom-factor-change", (_event, zoomFactor) => callback(zoomFactor)),
    onUpdaterStatusChange: (callback) => ipcRenderer.on("app-update-status", (_event, status) => callback(status)),
    getUpdaterStatus: () => ipcRenderer.sendSync("get-app-update-status"),
    getUpdaterChannel: () => ipcRenderer.sendSync("get-updater-channel"),
    installAppUpdate: () => ipcRenderer.send("install-app-update"),
    onMenuItemAbout: (callback) => ipcRenderer.on("menu-item-about", callback),
    onWorkspaceSnapshot: (callback) => ipcRenderer.on("workspace-snapshot", (_event, msg) => callback(msg)),
    workspaceSnapshotDone: (file, accepted) => ipcRenderer.send("workspace-snapshot-done", file, accepted),
    updateWindowControlsOverlay: (rect) => ipcRenderer.send("update-window-controls-overlay", rect),
    onReinjectKey: (callback) => ipcRenderer.on("reinject-key", (_event, waveEvent) => callback(waveEvent)),
    setWebviewFocus: (focused: number) => ipcRenderer.send("webview-focus", focused),
    registerGlobalWebviewKeys: (keys) => ipcRenderer.send("register-global-webview-keys", keys),
    onControlShiftStateUpdate: (callback) =>
        ipcRenderer.on("control-shift-state-update", (_event, state) => callback(state)),
    createWorkspace: () => ipcRenderer.send("create-workspace"),
    switchWorkspace: (workspaceId) => ipcRenderer.send("switch-workspace", workspaceId),
    deleteWorkspace: (workspaceId) => ipcRenderer.send("delete-workspace", workspaceId),
    setActiveTab: (tabId) => ipcRenderer.send("set-active-tab", tabId),
    createTab: () => ipcRenderer.send("create-tab"),
    closeTab: (workspaceId, tabId, confirmClose) => ipcRenderer.invoke("close-tab", workspaceId, tabId, confirmClose),
    setWindowInitStatus: (status) => ipcRenderer.send("set-window-init-status", status),
    onWaveInit: (callback) => ipcRenderer.on("wave-init", (_event, initOpts) => callback(initOpts)),
    onBuilderInit: (callback) => ipcRenderer.on("builder-init", (_event, initOpts) => callback(initOpts)),
    sendLog: (log) => ipcRenderer.send("fe-log", log),
    onQuicklook: (filePath: string) => ipcRenderer.send("quicklook", filePath),
    openNativePath: (filePath: string) => ipcRenderer.send("open-native-path", filePath),
    captureScreenshot: (rect: Rectangle) => ipcRenderer.invoke("capture-screenshot", rect),
    setKeyboardChordMode: () => ipcRenderer.send("set-keyboard-chord-mode"),
    clearWebviewStorage: (webContentsId: number) => ipcRenderer.invoke("clear-webview-storage", webContentsId),
    setWaveAIOpen: (isOpen: boolean) => ipcRenderer.send("set-waveai-open", isOpen),
    closeBuilderWindow: () => ipcRenderer.send("close-builder-window"),
    incrementTermCommands: (opts?: { isRemote?: boolean; isWsl?: boolean; isDurable?: boolean }) =>
        ipcRenderer.send("increment-term-commands", opts),
    nativePaste: () => ipcRenderer.send("native-paste"),
    openBuilder: (appId?: string) => ipcRenderer.send("open-builder", appId),
    setBuilderWindowAppId: (appId: string) => ipcRenderer.send("set-builder-window-appid", appId),
    doRefresh: () => ipcRenderer.send("do-refresh"),
    saveTextFile: (fileName: string, content: string) => ipcRenderer.invoke("save-text-file", fileName, content),
    pickDirectory: (title?: string) => ipcRenderer.invoke("pick-directory", title),
    readFileBase64: (filePath: string) => ipcRenderer.invoke("read-file-base64", filePath),
    readTextFile: (filePath: string) => ipcRenderer.invoke("read-text-file", filePath),
    writeTextFile: (filePath: string, content: string) => ipcRenderer.invoke("write-text-file", filePath, content),
    execCommand: (command: string) => ipcRenderer.invoke("exec-command", command),
    setIsActive: () => ipcRenderer.invoke("set-is-active"),

    // Terminus Cloud Sync
    terminusAuthLogin: () => ipcRenderer.invoke("terminus-auth-login"),
    terminusAuthLogout: () => ipcRenderer.invoke("terminus-auth-logout"),
    terminusAuthStatus: () => ipcRenderer.invoke("terminus-auth-status"),
    terminusSyncPull: () => ipcRenderer.invoke("terminus-sync-pull"),
    terminusSyncPush: (configs: Record<string, any>) => ipcRenderer.invoke("terminus-sync-push", configs),
    terminusDevices: () => ipcRenderer.invoke("terminus-devices"),
    terminusSyncToggle: (enabled: boolean) => ipcRenderer.invoke("terminus-sync-toggle", enabled),
});

// Custom event for "new-window"
ipcRenderer.on("webview-new-window", (e, webContentsId, details) => {
    const event = new CustomEvent("new-window", { detail: details });
    document.getElementById("webview").dispatchEvent(event);
});

ipcRenderer.on("webcontentsid-from-blockid", (e, blockId, responseCh) => {
    const webviewElem: WebviewTag = document.querySelector("div[data-blockid='" + blockId + "'] webview");
    const wcId = webviewElem?.dataset?.webcontentsid;
    ipcRenderer.send(responseCh, wcId);
});
