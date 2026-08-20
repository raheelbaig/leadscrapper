import { TZDate } from "@date-fns/tz";

/**
 * Billing-month arithmetic in the Google billing timezone.
 *
 * NEVER compute a billing month in UTC. Google's free allowance resets at
 * midnight Pacific, so a UTC rollover zeroes the local counter up to eight
 * hours early. In that window the application would believe it had free quota
 * left while Google was still billing the previous month -- which is exactly
 * the situation the FREE-ONLY guarantee exists to prevent.
 *
 * The timezone itself is never hardcoded here: it is a parameter, supplied by
 * the pricing catalog (`billingTimezone`) through the pricing service. The same
 * value is passed to `public.billing_period(p_tz)` in Postgres, so the database
 * and the application always agree on which month a call belongs to.
 *
 * Every function here is pure, takes an explicit `now` for testability, and
 * returns plain UTC `Date` instants at range boundaries. Ranges are half-open
 * (`start <= t < end`) so consecutive periods tile time with no gap and no
 * overlap -- the same property the tile grid relies on for geography.
 */

/** `YYYY-MM` in the billing timezone. Matches `public.billing_period()`. */
export type BillingPeriodKey = string;

/** `YYYY-MM-DD` in the billing timezone. */
export type BillingDayKey = string;

export type BillingPeriod = {
  /** `YYYY-MM`, the value stored in `api_usage_counters.period`. */
  key: BillingPeriodKey;
  /** Human label, e.g. "August 2026". */
  label: string;
  year: number;
  /** 1-12, not the JavaScript 0-11. */
  month: number;
  /** First instant of the month, in UTC. Inclusive. */
  start: Date;
  /** First instant of the NEXT month, in UTC. Exclusive. */
  end: Date;
  timeZone: string;
};

const PERIOD_KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTH_LABELS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export class InvalidBillingPeriodError extends Error {
  constructor(value: string) {
    super(`Invalid billing period key "${value}". Expected YYYY-MM.`);
    this.name = "InvalidBillingPeriodError";
  }
}

/**
 * Fails loudly on an unknown IANA zone. A silently-wrong timezone would shift
 * the month boundary, which is the one error this module exists to prevent.
 */
export function assertValidTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
  } catch {
    throw new Error(
      `Unknown billing timezone "${timeZone}". Check billingTimezone in src/server/pricing/catalog.json.`,
    );
  }
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * The UTC instant of local midnight on a calendar day in `timeZone`.
 *
 * TZDate's component constructor reads its arguments as WALL-CLOCK time in the
 * given zone, so `getTime()` is the corresponding UTC instant. The result is
 * converted straight back to a plain Date: TZDate#toISOString() renders a zone
 * offset rather than `Z`, and Supabase/Postgres want the UTC form.
 *
 * Month and day boundaries are unambiguous in practice -- US DST transitions
 * happen at 02:00 local on a Sunday, never at local midnight.
 */
function zonedMidnight(year: number, month: number, day: number, timeZone: string): Date {
  return new Date(new TZDate(year, month - 1, day, 0, 0, 0, timeZone).getTime());
}

/** Calendar days in a month, month given as 1-12. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseBillingPeriodKey(key: BillingPeriodKey): { year: number; month: number } {
  const match = PERIOD_KEY_RE.exec(key);
  if (!match) throw new InvalidBillingPeriodError(key);
  return { year: Number(match[1]), month: Number(match[2]) };
}

export function formatBillingPeriodKey(year: number, month: number): BillingPeriodKey {
  return `${year}-${pad2(month)}`;
}

/** Which billing month does this instant fall in? */
export function billingPeriodKeyFor(instant: Date, timeZone: string): BillingPeriodKey {
  assertValidTimeZone(timeZone);
  const local = new TZDate(instant, timeZone);
  return formatBillingPeriodKey(local.getFullYear(), local.getMonth() + 1);
}

/** Which billing day does this instant fall in? */
export function billingDayKeyFor(instant: Date, timeZone: string): BillingDayKey {
  assertValidTimeZone(timeZone);
  const local = new TZDate(instant, timeZone);
  return `${local.getFullYear()}-${pad2(local.getMonth() + 1)}-${pad2(local.getDate())}`;
}

export function billingPeriodLabel(key: BillingPeriodKey): string {
  const { year, month } = parseBillingPeriodKey(key);
  return `${MONTH_LABELS[month - 1]} ${year}`;
}

export function billingPeriod(key: BillingPeriodKey, timeZone: string): BillingPeriod {
  assertValidTimeZone(timeZone);
  const { year, month } = parseBillingPeriodKey(key);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;

  return {
    key,
    label: billingPeriodLabel(key),
    year,
    month,
    start: zonedMidnight(year, month, 1, timeZone),
    end: zonedMidnight(nextYear, nextMonth, 1, timeZone),
    timeZone,
  };
}

export function currentBillingPeriod(timeZone: string, now: Date = new Date()): BillingPeriod {
  return billingPeriod(billingPeriodKeyFor(now, timeZone), timeZone);
}

export function previousBillingPeriodKey(key: BillingPeriodKey): BillingPeriodKey {
  const { year, month } = parseBillingPeriodKey(key);
  return month === 1
    ? formatBillingPeriodKey(year - 1, 12)
    : formatBillingPeriodKey(year, month - 1);
}

export function nextBillingPeriodKey(key: BillingPeriodKey): BillingPeriodKey {
  const { year, month } = parseBillingPeriodKey(key);
  return month === 12
    ? formatBillingPeriodKey(year + 1, 1)
    : formatBillingPeriodKey(year, month + 1);
}

export function previousBillingPeriod(key: BillingPeriodKey, timeZone: string): BillingPeriod {
  return billingPeriod(previousBillingPeriodKey(key), timeZone);
}

export function nextBillingPeriod(key: BillingPeriodKey, timeZone: string): BillingPeriod {
  return billingPeriod(nextBillingPeriodKey(key), timeZone);
}

/**
 * Every calendar day in the period as `YYYY-MM-DD` keys.
 *
 * The usage chart uses this to build a complete x-axis: a day with no API calls
 * must render as a real zero, not as a gap that reads like missing data.
 */
export function billingPeriodDayKeys(period: BillingPeriod): BillingDayKey[] {
  const total = daysInMonth(period.year, period.month);
  const keys: BillingDayKey[] = [];
  for (let day = 1; day <= total; day += 1) {
    keys.push(`${period.year}-${pad2(period.month)}-${pad2(day)}`);
  }
  return keys;
}

/**
 * Half-open UTC range for one local calendar day. Correct across DST, where a
 * local day is 23 or 25 hours long rather than 24.
 */
export function billingDayRange(
  dayKey: BillingDayKey,
  timeZone: string,
): { start: Date; end: Date } {
  const match = DAY_KEY_RE.exec(dayKey);
  if (!match) throw new InvalidBillingPeriodError(dayKey);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  // Roll the calendar date forward in UTC purely to get the next day's
  // Y/M/D components; the instant is then re-derived in the billing timezone.
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));

  return {
    start: zonedMidnight(year, month, day, timeZone),
    end: zonedMidnight(
      nextDay.getUTCFullYear(),
      nextDay.getUTCMonth() + 1,
      nextDay.getUTCDate(),
      timeZone,
    ),
  };
}

/** Short axis label, e.g. "Aug 1". */
export function formatDayKeyShort(dayKey: BillingDayKey): string {
  const match = DAY_KEY_RE.exec(dayKey);
  if (!match) return dayKey;
  return `${MONTH_LABELS[Number(match[2]) - 1].slice(0, 3)} ${Number(match[3])}`;
}
