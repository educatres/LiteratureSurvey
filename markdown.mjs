import { marked } from './vendor/marked.mjs';
import DOMPurify from './vendor/purify.mjs';

// Return plain text when the browser cannot safely sanitize generated HTML.
export function renderMarkdown(text) {
  if (!DOMPurify.isSupported) return null;
  const html = marked.parse(String(text ?? ''), { gfm: true, breaks: true });
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
    ALLOWED_ATTR: ['href', 'title', 'start']
  });
}
