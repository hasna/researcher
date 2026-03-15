/**
 * Simple table formatter with ANSI colors. Zero dependencies.
 */

const COLORS = {
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
}

export function color(text: string, c: keyof typeof COLORS): string {
  return `${COLORS[c]}${text}${COLORS.reset}`
}

export function statusColor(status: string): string {
  switch (status) {
    case "completed": return color(status, "green")
    case "failed": return color(status, "red")
    case "running": return color(status, "yellow")
    case "paused": return color(status, "dim")
    default: return status
  }
}

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => {
    const maxRow = rows.reduce((max, row) => Math.max(max, stripAnsi(row[i] ?? "").length), 0)
    return Math.max(stripAnsi(h).length, maxRow)
  })

  const sep = widths.map(w => "─".repeat(w + 2)).join("┼")
  const headerLine = headers.map((h, i) => ` ${color(pad(h, widths[i]!), "bold")} `).join("│")
  const dataLines = rows.map(row =>
    row.map((cell, i) => ` ${pad(cell, widths[i]!)} `).join("│")
  )

  return [headerLine, `─${sep}─`, ...dataLines].join("\n")
}

function pad(str: string, width: number): string {
  const visible = stripAnsi(str).length
  return str + " ".repeat(Math.max(0, width - visible))
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[\d+m/g, "")
}
