import { Marked, type Tokens } from 'marked';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Model output is untrusted: raw HTML is shown as text, links must be https,
// images are never loaded (alt text only).
const md = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    html(t: Tokens.HTML | Tokens.Tag) {
      return esc(t.text);
    },
    link(this: any, t: Tokens.Link) {
      const inner = this.parser.parseInline(t.tokens);
      if (!/^https:\/\//i.test(t.href)) return inner;
      return `<a href="${esc(t.href)}" data-ext="1" title="${esc(t.href)}">${inner}</a>`;
    },
    image(t: Tokens.Image) {
      return esc(t.text || '');
    },
  },
});

export function renderMarkdown(src: string): string {
  return md.parse(src) as string;
}

/**
 * Render markdown into `el`, wrapping only text beyond `prevChars` (rendered
 * text characters) in `.w` spans so new words fade in while earlier ones
 * stay put. Returns the new rendered-text length.
 */
export function renderStreaming(el: HTMLElement, src: string, prevChars: number): number {
  el.innerHTML = renderMarkdown(src);
  let count = 0;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const n of nodes) {
    const t = n.data;
    const start = count;
    count += t.length;
    if (count <= prevChars) continue;
    const cut = Math.max(0, prevChars - start);
    const frag = document.createDocumentFragment();
    if (cut > 0) frag.append(t.slice(0, cut));
    for (const part of t.slice(cut).split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) frag.append(part);
      else {
        const s = document.createElement('span');
        s.className = 'w';
        s.textContent = part;
        frag.append(s);
      }
    }
    n.replaceWith(frag);
  }
  return count;
}
