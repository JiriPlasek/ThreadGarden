/**
 * The caret's line position inside a textarea, measured with an off-screen
 * mirror element that copies the textarea's text layout (the usual technique;
 * textareas expose no caret geometry). Only called while a picker is open, so
 * plain typing pays nothing for it.
 */
const COPIED = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'tabSize',
  'textTransform',
  'wordSpacing',
  'textIndent',
] as const;

/** Top of the caret's line relative to the textarea's visible top edge, in px. */
export const caretLineTop = (el: HTMLTextAreaElement, position: number): number => {
  const style = getComputedStyle(el);
  const mirror = document.createElement('div');
  const s = mirror.style;
  for (const k of COPIED) s[k] = style[k];
  s.position = 'absolute';
  s.visibility = 'hidden';
  s.top = '0';
  s.left = '-9999px';
  s.whiteSpace = 'pre-wrap';
  s.overflowWrap = 'break-word';
  s.overflow = 'hidden';
  mirror.textContent = el.value.slice(0, position);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const top = marker.offsetTop - el.scrollTop;
  mirror.remove();
  return Math.max(0, top);
};
