// What the spike found about the CLI's `!` entries:
// docs/superpowers/specs/2026-11-22-shell-commands-spike-results.md ("Constants for the build").

/** The CLI's own output limit (results doc: OUTPUT_LIMIT). */
export const OUTPUT_LIMIT = 30000;

/** Goes above the kept end, inside `<bash-stdout>` (results doc: CUT_NOTE). ‹N› is the full length. */
export const CUT_NOTE = 'Output too large (‹N› characters); only the last 30000 are kept.';

/** The CLI writes the command and its output as two user entries (results doc: ENTRY_SHAPE). */
export const ENTRY_SHAPE: 'one' | 'two' = 'two';

/** The CLI HTML-escapes `<` and `>` in output (results doc: ENTRY_FORMAT, TAGS_ESCAPED). */
export const TAGS_ESCAPED = true;

/** A `shouldQuery: false` message is not echoed on the SDK stream (results doc: ECHOES). */
export const ECHOES = false;

const ESC = '\u001b';

/** Index just past the string-type escape (OSC, DCS, ...) that starts at `from`, ended by BEL or ST. */
const skipString = (raw: string, from: number): number => {
  for (let i = from; i < raw.length; i++) {
    if (raw[i] === '\u0007') return i + 1;
    if (raw[i] === ESC && raw[i + 1] === '\\') return i + 2;
  }
  return raw.length;
};

/** The text a terminal would show for what a command wrote to a pseudo-terminal. */
export const terminalText = (raw: string): string => {
  const lines: string[][] = [[]];
  let col = 0;
  const line = (): string[] => lines[lines.length - 1] as string[];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i] as string;
    if (ch === ESC) {
      const next = raw[i + 1];
      if (next === '[') {
        // CSI: parameters, intermediates, then a final byte 0x40-0x7e.
        let j = i + 2;
        while (j < raw.length && (raw.charCodeAt(j) < 0x40 || raw.charCodeAt(j) > 0x7e)) j++;
        i = j + 1;
      } else if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
        i = skipString(raw, i + 2);
      } else if (next === undefined) {
        i++;
      } else {
        // Two-character escape, or one with intermediates (ESC ( B).
        let j = i + 1;
        while (j < raw.length && raw.charCodeAt(j) >= 0x20 && raw.charCodeAt(j) <= 0x2f) j++;
        i = j + 1;
      }
      continue;
    }
    i++;
    if (ch === '\r') {
      if (raw[i] === '\n') continue; // CRLF is handled as the line feed
      col = 0;
    } else if (ch === '\n') {
      lines.push([]);
      col = 0;
    } else if (ch === '\b') {
      col = Math.max(0, col - 1);
    } else if (ch >= ' ' || ch === '\t') {
      const l = line();
      while (l.length < col) l.push(' ');
      l[col] = ch;
      col++;
    }
  }
  const out = lines.map((l) => l.join('').replace(/ +$/, ''));
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
};

/** Text up to OUTPUT_LIMIT unchanged; past it the end, from a line start, under CUT_NOTE. */
export const limitOutput = (text: string): string => {
  if (text.length <= OUTPUT_LIMIT) return text;
  let kept = text.slice(text.length - OUTPUT_LIMIT);
  const lineBreak = kept.indexOf('\n');
  if (lineBreak >= 0) kept = kept.slice(lineBreak + 1);
  return `${CUT_NOTE.replace('‹N›', String(text.length))}\n${kept}`;
};

const escapeTags = (s: string): string =>
  TAGS_ESCAPED ? s.replace(/</g, '&lt;').replace(/>/g, '&gt;') : s;

/** The user entries to append for a finished `!` command, as the CLI writes them. */
export const bashEntry = (command: string, output: string): string[] => {
  const input = `<bash-input>${command}</bash-input>`;
  const result = `<bash-stdout>${escapeTags(output)}</bash-stdout><bash-stderr></bash-stderr>`;
  return ENTRY_SHAPE === 'two' ? [input, result] : [`${input}\n${result}`];
};
