import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

// ─── Popup content rendering ──────────────────────────────────────────────────
//
// Admins author popups in GitHub-flavoured Markdown with inline HTML allowed
// (colors, alignment, <u>, <mark>, <img width>, …). The server renders and
// sanitises once, at save time, and clients only ever receive `contentHtml`.
// That keeps Web, Android and the admin preview byte-identical and means no
// client has to ship a Markdown parser or trust raw admin input.

const IMAGE_URL = /^https?:\/\/[^\s<>"'`]+\.(?:png|jpe?g|gif|webp|avif|svg|bmp)(?:[?#][^\s<>"'`]*)?$/i;

// A bare image link on its own ("https://…/pic.png") becomes an image, like
// pasting a link into a chat. Only whitespace-delimited URLs outside code are
// touched, so URLs inside Markdown links, HTML attributes or code stay as-is.
export function autoEmbedImageUrls(source: string): string {
  let inFence = false;
  return source
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence || /^( {4}|\t)/.test(line)) return line;
      // Even segments are outside inline `code`.
      return line
        .split('`')
        .map((segment, i) => (i % 2 === 1 ? segment : segment.replace(
          /(^|\s)(https?:\/\/\S+)(?=\s|$)/g,
          (match, lead: string, url: string) => (IMAGE_URL.test(url) ? `${lead}![](${url})` : match),
        )))
        .join('`');
    })
    .join('\n');
}

const COLOR = [/^#[0-9a-f]{3,8}$/i, /^rgba?\(\s*[\d.\s,%]+\)$/i, /^hsla?\(\s*[\d.\s,%deg]+\)$/i, /^[a-z]{3,20}$/i];
const LENGTH = [/^\d{1,3}(?:\.\d+)?(?:px|em|rem|%)$/];

const SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    ...sanitizeHtml.defaults.allowedTags,
    'img', 'h1', 'h2', 'del', 's', 'u', 'mark', 'span', 'center', 'font',
    'details', 'summary', 'sup', 'sub', 'kbd', 'input', 'small', 'big',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'align', 'loading'],
    input: ['type', 'checked', 'disabled'],
    font: ['color', 'size'],
    td: ['align', 'colspan', 'rowspan', 'style'],
    th: ['align', 'colspan', 'rowspan', 'style'],
    ol: ['start'],
    '*': ['align', 'style'],
  },
  allowedStyles: {
    '*': {
      color: COLOR,
      'background-color': COLOR,
      background: COLOR,
      'text-align': [/^(?:left|right|center|justify)$/],
      'font-size': LENGTH,
      'font-weight': [/^(?:normal|bold|[1-9]00)$/],
      'font-style': [/^(?:normal|italic)$/],
      'text-decoration': [/^(?:none|underline|line-through)$/],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' },
    }),
    img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: 'lazy' } }),
    // GFM task-list checkboxes are display-only.
    input: (tagName, attribs) => ({ tagName, attribs: { ...attribs, disabled: 'disabled' } }),
  },
  // Drop non-checkbox inputs, and images whose src was stripped as unsafe.
  exclusiveFilter: (frame) =>
    (frame.tag === 'input' && frame.attribs['type'] !== 'checkbox') ||
    (frame.tag === 'img' && !frame.attribs['src']),
};

export function renderPopupContent(source: string): string {
  const html = marked.parse(autoEmbedImageUrls(source), { gfm: true, breaks: true, async: false }) as string;
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}
