// When a renderer runs inside the demo stage (an iframe, no preload), this
// stands in for `window.cadabra`: messages come from the parent via
// postMessage and user actions are posted back.

export type Listener = (m: any) => void;

export function isDemo(): boolean {
  return !(window as any).cadabra;
}

export function demoChannel(onMsg: Listener) {
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && d.cadabraDemo) onMsg(d.msg);
  });
}

export function postToStage(kind: string, payload: unknown = null) {
  window.parent?.postMessage({ cadabraDemoOut: true, kind, payload }, '*');
}

/** Freeze every CSS animation/transition in this document `after` ms from now. */
export function freezeCssAfter(after: number) {
  setTimeout(() => {
    for (const a of document.getAnimations()) a.pause();
  }, after);
}
