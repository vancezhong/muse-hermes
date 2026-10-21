import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({ breaks: true, gfm: true })

export function renderMarkdown(source) {
  return DOMPurify.sanitize(marked.parse(source || ''), {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'rel'],
  })
}
