import * as p from '@clack/prompts';
import { cursor, erase } from 'sisteransi';

/**
 * Erase the cancelled prompt output from the terminal.
 *
 * When @clack/prompts renders a cancel state, it shows the prompt message
 * with the selected value crossed out (strikethrough). This is confusing
 * because pressing ESC should cleanly return to the previous menu.
 *
 * This function moves the cursor up past the cancelled prompt's rendered
 * lines and erases them, so the user sees a clean return.
 */
function eraseCancelledPrompt(lines = 2): void {
  process.stdout.write(cursor.move(0, -lines) + erase.down());
}

type SelectOptions<T> = Parameters<typeof p.select<T>>[0];
type MultiselectOptions<T> = Parameters<typeof p.multiselect<T>>[0];
type TextOptions = Parameters<typeof p.text>[0];
type ConfirmOptions = Parameters<typeof p.confirm>[0];

/**
 * Wrapper around p.select that erases the strikethrough on cancel.
 */
export async function select<T>(opts: SelectOptions<T>): Promise<T | symbol> {
  const result = await p.select<T>(opts);
  if (p.isCancel(result)) {
    eraseCancelledPrompt();
  }
  return result;
}

/**
 * Wrapper around p.multiselect that erases the strikethrough on cancel.
 */
export async function multiselect<T>(
  opts: MultiselectOptions<T>,
): Promise<T[] | symbol> {
  const result = await p.multiselect<T>(opts);
  if (p.isCancel(result)) {
    eraseCancelledPrompt();
  }
  return result;
}

/**
 * Wrapper around p.text that erases the strikethrough on cancel.
 */
export async function text(opts: TextOptions): Promise<string | symbol> {
  const result = await p.text(opts);
  if (p.isCancel(result)) {
    eraseCancelledPrompt();
  }
  return result;
}

/**
 * Wrapper around p.confirm that erases the strikethrough on cancel.
 */
export async function confirm(opts: ConfirmOptions): Promise<boolean | symbol> {
  const result = await p.confirm(opts);
  if (p.isCancel(result)) {
    eraseCancelledPrompt();
  }
  return result;
}
