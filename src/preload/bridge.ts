// Single preload for Cadabra renderers (sandboxed, contextIsolation on).
// The role is passed via `additionalArguments: ['--cadabra-role=panel']`.
import { contextBridge, ipcRenderer } from 'electron';

const role = (process.argv.find((a) => a.startsWith('--cadabra-role=')) ?? '').split('=')[1] ?? 'panel';

function on(channel: string, cb: (m: any) => void) {
  ipcRenderer.removeAllListeners(channel);
  ipcRenderer.on(channel, (_e, m) => cb(m));
}

if (role === 'mic') {
  // The voice port is handed to the page with postMessage (MessagePorts can
  // cross the context-isolation boundary that way).
  ipcRenderer.on('voice:port', (e) => window.postMessage({ cadabraVoicePort: true }, '*', e.ports));
  contextBridge.exposeInMainWorld('cadabra', {
    role,
    onCommand: (cb: (m: any) => void) => on('mic:cmd', cb),
    status: (m: unknown) => ipcRenderer.send('mic:status', m),
  });
} else if (role === 'overlay') {
  contextBridge.exposeInMainWorld('cadabra', {
    role,
    onMessage: (cb: (m: any) => void) => on('overlay:msg', cb),
    ready: () => ipcRenderer.send('overlay:ready'),
    idle: () => ipcRenderer.send('overlay:idle'),
  });
} else {
  contextBridge.exposeInMainWorld('cadabra', {
    role,
    onMessage: (cb: (m: any) => void) => on('panel:msg', cb),
    send: (text: string) => ipcRenderer.send('panel:send', String(text)),
    cancel: () => ipcRenderer.send('panel:cancel'),
    dismiss: () => ipcRenderer.send('panel:dismiss'),
    resolveConfirm: (id: string, allowed: boolean, always?: boolean) => ipcRenderer.send('panel:confirm', String(id), !!allowed, !!always),
    permList: () => ipcRenderer.invoke('perm:list'),
    permRevoke: (scope: string, cls: string) => ipcRenderer.invoke('perm:revoke', String(scope), String(cls)),
    listProviders: () => ipcRenderer.invoke('panel:providers'),
    setModel: (provider: string, model: string) => ipcRenderer.invoke('panel:set-model', String(provider), String(model)),
    newChat: () => ipcRenderer.send('panel:new-chat'),
    launchApp: (id: string) => ipcRenderer.send('panel:launch-app', String(id)),
    openExternal: (url: string) => ipcRenderer.send('panel:open-external', String(url)),
    openSettings: () => ipcRenderer.send('panel:open-settings'),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    setSettings: (patch: unknown) => ipcRenderer.invoke('settings:set', patch),
    setRecording: (on: boolean) => ipcRenderer.send('binding:recording', !!on),
    setSecret: (key: string, value: string | null) => ipcRenderer.invoke('secret:set', String(key), value == null ? null : String(value)),
    accountOptions: (provider: string) => ipcRenderer.invoke('account:options', String(provider)),
    signIn: (provider: string, optionId: string, key: string | null) => ipcRenderer.invoke('account:sign-in', String(provider), String(optionId), key == null ? null : String(key)),
    signOut: (provider: string) => ipcRenderer.invoke('account:sign-out', String(provider)),
    testProvider: (provider: string) => ipcRenderer.invoke('account:test', String(provider)),
    installCli: (provider: string) => ipcRenderer.invoke('account:install', String(provider)),
    browseCli: (provider: string) => ipcRenderer.invoke('account:browse-cli', String(provider)),
    ttsStatus: () => ipcRenderer.invoke('voice:tts-status'),
    ttsDownload: () => ipcRenderer.invoke('voice:tts-download'),
    previewVoice: (voice: string, speed: number) => ipcRenderer.invoke('voice:preview', String(voice), Number(speed)),
    voiceStatus: () => ipcRenderer.invoke('voice:status'),
    restartVoice: () => ipcRenderer.invoke('voice:restart'),
    voiceDevices: () => ipcRenderer.invoke('voice:devices'),
    useVoiceDevice: (label: string) => ipcRenderer.invoke('voice:use-device', String(label)),
    markMicNotCall: (exe: string, on: boolean) => ipcRenderer.invoke('voice:mic-not-call', String(exe), !!on),
    micStatus: () => ipcRenderer.invoke('onboard:mic'),
    openMicSettings: () => ipcRenderer.send('onboard:open-mic-settings'),
    emailStatus: () => ipcRenderer.invoke('email:status'),
    announceOutputs: () => ipcRenderer.invoke('announce:outputs'),
    announceTest: () => ipcRenderer.invoke('announce:test'),
    skillsList: () => ipcRenderer.invoke('skills:list'),
    skillsSetEnabled: (id: string, on: boolean) => ipcRenderer.invoke('skills:set-enabled', String(id), !!on),
    skillsView: (id: string) => ipcRenderer.invoke('skills:view', String(id)),
    skillsOpenFolder: (which: string) => ipcRenderer.invoke('skills:open-folder', String(which)),
    skillsNew: (name: string) => ipcRenderer.invoke('skills:new', String(name)),
    skillsReload: () => ipcRenderer.invoke('skills:reload'),
    waStatus: () => ipcRenderer.invoke('wa:status'),
    waSetToken: (t: string | null) => ipcRenderer.invoke('wa:set-token', t == null ? null : String(t)),
    waTest: () => ipcRenderer.invoke('wa:test'),
    waEnable: (on: boolean) => ipcRenderer.invoke('wa:enable', !!on),
    waPair: () => ipcRenderer.invoke('wa:pair'),
    waUnpair: () => ipcRenderer.invoke('wa:unpair'),
    waAutonomy: (a: string) => ipcRenderer.invoke('wa:autonomy', String(a)),
    emailSetBodies: (on: boolean) => ipcRenderer.invoke('email:set-bodies', !!on),
    emailOpenHelp: (which: string) => ipcRenderer.send('email:open-help', String(which)),
    emailConnectOAuth: (clientIdOrJson: string, clientSecret: string | null) => ipcRenderer.invoke('email:connect-oauth', String(clientIdOrJson), clientSecret == null ? null : String(clientSecret)),
    emailConnectImap: (address: string, appPassword: string) => ipcRenderer.invoke('email:connect-imap', String(address), String(appPassword)),
    emailDisconnect: () => ipcRenderer.invoke('email:disconnect'),
    ready: () => ipcRenderer.send('panel:ready'),
  });
}
