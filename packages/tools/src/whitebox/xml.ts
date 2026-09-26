/**
 * Small, tolerant XML parser for test and coverage reports (JUnit, Cobertura). Supports elements,
 * attributes (single/double quotes, unquoted tolerated), text, CDATA, comments, processing instructions,
 * DOCTYPE, the five predefined entities and numeric character references. Tolerant by design: unknown
 * entities are kept verbatim, a mismatched close tag closes up to the nearest matching open element (or is
 * ignored), unclosed elements are closed at end of input. Not a validating parser; no external entities.
 */
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Concatenated character data (text + CDATA) directly inside this element. */
  text: string;
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (m, body: string) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
      return String.fromCodePoint(cp);
    }
    return NAMED[body] ?? m;
  });
}

function parseAttributes(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>/]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1]!;
    const raw = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[name] = decodeEntities(raw);
  }
  return attrs;
}

/** Parses a document; returns a synthetic root `#document` whose children are the top-level elements. */
export function parseXml(input: string): XmlElement {
  const doc: XmlElement = { name: '#document', attrs: {}, children: [], text: '' };
  const stack: XmlElement[] = [doc];
  const top = () => stack[stack.length - 1]!;
  let i = 0;
  const n = input.length;
  // strip a BOM
  if (input.charCodeAt(0) === 0xfeff) i = 1;
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
      continue;
    }
    if (input.startsWith('<![CDATA[', lt)) {
      const end = input.indexOf(']]>', lt + 9);
      top().text += input.slice(lt + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (input.startsWith('<?', lt)) {
      const end = input.indexOf('?>', lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (input.startsWith('<!', lt)) {
      // DOCTYPE (possibly with an internal subset in [...])
      let j = lt + 2;
      let depth = 0;
      while (j < n) {
        const c = input[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (input[lt + 1] === '/') {
      const end = input.indexOf('>', lt + 2);
      const name = input.slice(lt + 2, end < 0 ? n : end).trim();
      i = end < 0 ? n : end + 1;
      // close up to the nearest matching element; ignore a stray close tag
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k]!.name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    // start tag: find the closing '>' outside quotes
    let j = lt + 1;
    let quote: string | undefined;
    while (j < n) {
      const c = input[j]!;
      if (quote) {
        if (c === quote) quote = undefined;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    let body = input.slice(lt + 1, j);
    i = j < n ? j + 1 : n;
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1);
    const nameMatch = /^\s*([^\s/>]+)/.exec(body);
    if (!nameMatch) continue;
    const el: XmlElement = { name: nameMatch[1]!, attrs: parseAttributes(body.slice(nameMatch[0].length)), children: [], text: '' };
    top().children.push(el);
    if (!selfClosing) stack.push(el);
  }
  return doc;
}

/** Depth-first search for elements with the given (local) name. */
export function findAll(root: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const visit = (e: XmlElement) => {
    for (const c of e.children) {
      if (localName(c.name) === name) out.push(c);
      visit(c);
    }
  };
  visit(root);
  return out;
}

export function localName(name: string): string {
  const i = name.indexOf(':');
  return i < 0 ? name : name.slice(i + 1);
}

export function child(e: XmlElement, name: string): XmlElement | undefined {
  return e.children.find((c) => localName(c.name) === name);
}

/** All text below an element (own text + descendants), in document order approximately. */
export function deepText(e: XmlElement): string {
  return e.text + e.children.map(deepText).join('');
}
