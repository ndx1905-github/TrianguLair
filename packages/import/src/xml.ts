// SPDX-License-Identifier: MPL-2.0
/**
 * A tolerant, dependency-free XML reader for KML: React Native has no
 * DOMParser. Elements, attributes, text, CDATA, comments, processing
 * instructions and DOCTYPE are handled; namespaces are reduced to local
 * names (`kml:Placemark` → `Placemark`); predefined and numeric entities are
 * decoded. Not a validating parser: unclosed elements are closed at the end.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated text and CDATA directly inside this element. */
  text: string;
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[e.toLowerCase()] ?? whole;
  });
}

const localName = (n: string) => {
  const i = n.indexOf(':');
  return i >= 0 ? n.slice(i + 1) : n;
};

export function parseXml(input: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  const top = () => stack[stack.length - 1]!;
  let i = 0;
  const n = input.length;
  while (i < n) {
    const lt = input.indexOf('<', i);
    if (lt < 0) {
      top().text += decodeEntities(input.slice(i));
      break;
    }
    if (lt > i) top().text += decodeEntities(input.slice(i, lt));
    if (input.startsWith('<!--', lt)) {
      const end = input.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
    } else if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      top().text += input.slice(lt + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
    } else if (input.startsWith('<?', lt)) {
      const end = input.indexOf('?>', lt + 2);
      i = end < 0 ? n : end + 2;
    } else if (input.startsWith('<!', lt)) {
      // DOCTYPE (possibly with an internal subset in brackets).
      let j = lt + 2;
      let depth = 0;
      while (j < n && !(input[j] === '>' && depth === 0)) {
        if (input[j] === '[') depth++;
        else if (input[j] === ']') depth--;
        j++;
      }
      i = j + 1;
    } else if (input[lt + 1] === '/') {
      const end = input.indexOf('>', lt);
      const name = localName(input.slice(lt + 2, end < 0 ? n : end).trim());
      // Close up to the matching element (tolerates unclosed children).
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      }
      i = end < 0 ? n : end + 1;
    } else {
      // Start tag: find its end outside attribute quotes.
      let j = lt + 1;
      let q: string | null = null;
      while (j < n) {
        const ch = input[j]!;
        if (q) {
          if (ch === q) q = null;
        } else if (ch === '"' || ch === "'") q = ch;
        else if (ch === '>') break;
        j++;
      }
      const raw = input.slice(lt + 1, j);
      const selfClosing = raw.endsWith('/');
      const body = selfClosing ? raw.slice(0, -1) : raw;
      const m = /^\s*([^\s/>]+)/.exec(body);
      if (!m) {
        // A stray "<": keep it as text.
        top().text += '<';
        i = lt + 1;
        continue;
      }
      const el: XmlElement = { name: localName(m[1]!), attrs: {}, children: [], text: '' };
      const attrRe = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
      const rest = body.slice(m[0].length);
      for (let a = attrRe.exec(rest); a; a = attrRe.exec(rest)) {
        el.attrs[localName(a[1]!)] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
      }
      top().children.push(el);
      if (!selfClosing) stack.push(el);
      i = j + 1;
    }
  }
  return root;
}

export function child(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c) => c.name === name);
}

export function children(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c) => c.name === name);
}

/** Depth-first search of every descendant with this name. */
export function descendants(el: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of el.children) {
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}

/** Text of a child element (trimmed), or undefined. */
export function childText(el: XmlElement, name: string): string | undefined {
  const c = child(el, name);
  if (!c) return undefined;
  const t = allText(c).trim();
  return t === '' ? undefined : t;
}

/** All text inside an element, children included (for descriptions with stray markup). */
export function allText(el: XmlElement): string {
  return el.text + el.children.map(allText).join('');
}
