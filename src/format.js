/**
 * Renders rows as an aligned, plain-text table (no colors or box
 * drawing, so output stays greppable and identical in CI logs).
 *
 * @param {string[]} headers
 * @param {string[][]} rows
 * @param {string} [indent]
 * @returns {string[]} lines
 */
export function table(headers, rows, indent = "  ") {
  const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => String(row[i] ?? "").length)));
  const line = (cells) =>
    indent +
    cells
      .map((cell, i) => String(cell ?? "").padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)];
}

/** `1 model` / `2 models` */
export function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
