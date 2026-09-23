const rfc3339TimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    default:
      return 31;
  }
}

/**
 * Parse the RFC3339 shape accepted by the VSleep backend timeline boundary.
 *
 * JavaScript Date.parse accepts implementation-defined conveniences such as a
 * space instead of `T`, a missing timezone, or calendar dates it normalizes
 * into the following month. Chrono's `DateTime::parse_from_rfc3339` does not
 * treat those strings as usable evidence. Keep the frontend conservative so a
 * timestamp cannot become authoritative only after crossing the Tauri boundary.
 *
 * The current journal producer emits millisecond UTC (`...SS.sssZ`). This parser
 * also accepts standard RFC3339 numeric offsets and longer fractional seconds;
 * fractions are truncated to milliseconds to mirror backend `timestamp_millis()`.
 */
export function parseVSleepRfc3339TimestampMs(value: string): number | null {
  const match = rfc3339TimestampPattern.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? '';
  const offsetSign = match[8];
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }

  const millisecond = Number(fraction.padEnd(3, '0').slice(0, 3) || '0');
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  let timestampMs = date.getTime();

  if (offsetSign) {
    const offsetMs = (offsetHour * 60 + offsetMinute) * 60_000;
    timestampMs += offsetSign === '+' ? -offsetMs : offsetMs;
  }

  return Number.isSafeInteger(timestampMs) ? timestampMs : null;
}
