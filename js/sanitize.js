// Keeps node text down to plain text + <b>, <i>, <u>, <br>. Nothing else survives.
window.Sanitize = (() => {
  const tpl = document.createElement('template');
  const BLOCK = new Set(['DIV', 'P', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'BLOCKQUOTE', 'PRE', 'TR', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED', 'NOSCRIPT',
    'HEAD', 'TITLE', 'META', 'LINK', 'SVG', 'MATH', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS',
    'SELECT', 'BUTTON', 'INPUT', 'TEXTAREA']);

  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function marks(el, tag) {
    const st = (el.getAttribute('style') || '').toLowerCase();
    return {
      b: tag === 'B' || tag === 'STRONG' || /font-weight\s*:\s*(bold|bolder|[6-9]00)/.test(st),
      i: tag === 'I' || tag === 'EM' || /font-style\s*:\s*italic/.test(st),
      u: tag === 'U' || /text-decoration[^;]*underline/.test(st),
    };
  }

  function rich(html) {
    if (!html) return '';
    tpl.innerHTML = String(html);
    let out = '';
    const walk = parent => {
      for (const ch of parent.childNodes) {
        if (ch.nodeType === 3) { out += esc(ch.nodeValue); continue; }
        if (ch.nodeType !== 1) continue;
        const tag = ch.tagName.toUpperCase();
        if (SKIP.has(tag)) continue;
        if (tag === 'BR') { out += '<br>'; continue; }
        if (BLOCK.has(tag) && out && !out.endsWith('<br>')) out += '<br>';
        const m = marks(ch, tag);
        out += (m.b ? '<b>' : '') + (m.i ? '<i>' : '') + (m.u ? '<u>' : '');
        walk(ch);
        out += (m.u ? '</u>' : '') + (m.i ? '</i>' : '') + (m.b ? '</b>' : '');
      }
    };
    walk(tpl.content);
    tpl.innerHTML = '';
    let prev;
    do {
      prev = out;
      out = out.replace(/<(b|i|u)><\/\1>/g, '').replace(/<\/(b|i|u)><\1>/g, '');
    } while (out !== prev);
    return out === '<br>' ? '' : out;
  }

  function plain(html) {
    if (!html) return '';
    tpl.innerHTML = String(html).replace(/<br\s*\/?>/gi, '\n');
    const text = tpl.content.textContent;
    tpl.innerHTML = '';
    return text;
  }

  return { rich, plain };
})();
