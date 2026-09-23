const rfc3339TimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/;

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
 * Parse the RFC3339 forms accepted by chrono 0.4.45's
 * `DateTime::parse_from_rfc3339`, then expose the same millisecond precision
 * used by the backend timeline.
 *
 * Chrono accepts `T`, `t`, or a single space between date/time, upper/lowercase
 * `Z`, numeric offsets from -23:59 through +23:59, leap-second `:60`, and any
 * number of fractional digits (discarding precision past nanoseconds). JavaScript
 * `Date.parse` also accepts non-RFC3339 conveniences that Chrono rejects, such as
 * a missing timezone, `24:00:00`, invalid calendar dates that are normalized into
 * the next month, or colonless numeric offsets. Keep those forms forensic-only so
 * evidence cannot become authoritative merely after crossing the Tauri boundary.
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
    second > 60 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }

  const leapSecondMs = second === 60 ? 1_000 : 0;
  const normalizedSecond = second === 60 ? 59 : second;
  const millisecond = Number(fraction.padEnd(3, '0').slice(0, 3) || '0');
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, normalizedSecond, millisecond + leapSecondMs);
  let timestampMs = date.getTime();

  if (offsetSign) {
    const offsetMs = (offsetHour * 60 + offsetMinute) * 60_000;
    timestampMs += offsetSign === '+' ? -offsetMs : offsetMs;
  }

  return Number.isSafeInteger(timestampMs) ? timestampMs : null;
}
