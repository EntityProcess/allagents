/**
 * Render repository- and user-controlled text safely in an interactive terminal.
 *
 * ANSI/OSC sequences can alter earlier output, set terminal titles, or forge
 * prompt/status lines. C0/C1 and bidirectional formatting controls can do the
 * same without being visible. Remove complete terminal escape sequences, then
 * replace any remaining control characters with a visible replacement marker.
 * JSON output intentionally does not use this helper so automation receives
 * the original value.
 */
const ESC = 0x1b;
const CSI = 0x9b;
const OSC = 0x9d;
const STRING_TERMINATOR = 0x9c;
const REPLACEMENT = '\uFFFD';

function consumeControlString(
  value: string,
  start: number,
  allowBell: boolean,
): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((allowBell && code === 0x07) || code === STRING_TERMINATOR) {
      return index + 1;
    }
    if (code === ESC && value.charCodeAt(index + 1) === 0x5c) {
      return index + 2;
    }
  }
  return value.length;
}

function consumeCsi(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
  }
  return value.length;
}

function consumeEscape(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    index += 1;
    if (code < 0x20 || code > 0x2f) break;
  }
  return index;
}

function isDirectionControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

export function terminalSafe(value: unknown): string {
  const text = String(value);
  let safe = '';

  for (let index = 0; index < text.length; ) {
    const code = text.charCodeAt(index);
    if (code === ESC) {
      const next = text.charCodeAt(index + 1);
      if (next === 0x5d) {
        index = consumeControlString(text, index + 2, true);
      } else if ([0x50, 0x58, 0x5e, 0x5f].includes(next)) {
        index = consumeControlString(text, index + 2, false);
      } else if (next === 0x5b) {
        index = consumeCsi(text, index + 2);
      } else {
        index = consumeEscape(text, index + 1);
      }
      continue;
    }
    if (code === OSC) {
      index = consumeControlString(text, index + 1, true);
      continue;
    }
    if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) {
      index = consumeControlString(text, index + 1, false);
      continue;
    }
    if (code === CSI) {
      index = consumeCsi(text, index + 1);
      continue;
    }
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      isDirectionControl(code)
    ) {
      safe += REPLACEMENT;
    } else {
      safe += text[index];
    }
    index += 1;
  }

  return safe;
}
