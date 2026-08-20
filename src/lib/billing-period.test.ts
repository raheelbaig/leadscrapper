import { describe, expect, it } from "vitest";

import {
  InvalidBillingPeriodError,
  assertValidTimeZone,
  billingDayKeyFor,
  billingDayRange,
  billingPeriod,
  billingPeriodDayKeys,
  billingPeriodKeyFor,
  billingPeriodLabel,
  currentBillingPeriod,
  daysInMonth,
  formatDayKeyShort,
  nextBillingPeriod,
  nextBillingPeriodKey,
  previousBillingPeriod,
  previousBillingPeriodKey,
} from "./billing-period";

const LA = "America/Los_Angeles";
const hours = (ms: number) => ms / 3_600_000;

describe("billing period keys", () => {
  it("names the month the instant falls in locally", () => {
    expect(billingPeriodKeyFor(new Date("2026-08-21T12:00:00Z"), LA)).toBe("2026-08");
  });

  it("keeps the last Pacific hours of a month in that month", () => {
    // 2026-09-01T04:00Z is 21:00 on 31 August in Los Angeles. A UTC-based
    // rollover would call this September, zero the counter eight hours early,
    // and spend real money in the gap. This is the single most important
    // assertion in the file.
    const lateAugust = new Date("2026-09-01T04:00:00Z");
    expect(lateAugust.toISOString().slice(0, 7)).toBe("2026-09");
    expect(billingPeriodKeyFor(lateAugust, LA)).toBe("2026-08");
  });

  it("rolls over exactly at local midnight, not before", () => {
    // Pacific Daylight Time is UTC-7 in September.
    expect(billingPeriodKeyFor(new Date("2026-09-01T06:59:59Z"), LA)).toBe("2026-08");
    expect(billingPeriodKeyFor(new Date("2026-09-01T07:00:00Z"), LA)).toBe("2026-09");
  });

  it("rolls the year over at local midnight too", () => {
    // Pacific Standard Time is UTC-8 in January.
    expect(billingPeriodKeyFor(new Date("2027-01-01T07:59:59Z"), LA)).toBe("2026-12");
    expect(billingPeriodKeyFor(new Date("2027-01-01T08:00:00Z"), LA)).toBe("2027-01");
  });

  it("disagrees with UTC in the gap, which is the point", () => {
    const instant = new Date("2027-01-01T03:00:00Z");
    expect(billingPeriodKeyFor(instant, "UTC")).toBe("2027-01");
    expect(billingPeriodKeyFor(instant, LA)).toBe("2026-12");
  });
});

describe("period ranges", () => {
  it("starts and ends at local midnight, expressed in UTC", () => {
    const period = billingPeriod("2026-08", LA);
    expect(period.start.toISOString()).toBe("2026-08-01T07:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-09-01T07:00:00.000Z");
    expect(period.label).toBe("August 2026");
  });

  it("uses standard time for a winter month", () => {
    const period = billingPeriod("2026-12", LA);
    expect(period.start.toISOString()).toBe("2026-12-01T08:00:00.000Z");
    expect(period.end.toISOString()).toBe("2027-01-01T08:00:00.000Z");
  });

  it("spans a month that contains a DST transition", () => {
    // November 2026 begins on PDT and ends on PST, so it is one hour longer
    // than 30 x 24.
    const period = billingPeriod("2026-11", LA);
    expect(period.start.toISOString()).toBe("2026-11-01T07:00:00.000Z");
    expect(period.end.toISOString()).toBe("2026-12-01T08:00:00.000Z");
    expect(hours(period.end.getTime() - period.start.getTime())).toBe(30 * 24 + 1);
  });

  it("tiles time with no gap and no overlap", () => {
    const august = billingPeriod("2026-08", LA);
    const september = nextBillingPeriod("2026-08", LA);
    expect(september.start.getTime()).toBe(august.end.getTime());
  });

  it("is half-open, so the boundary instant belongs to the later month", () => {
    const august = billingPeriod("2026-08", LA);
    expect(billingPeriodKeyFor(august.end, LA)).toBe("2026-09");
    expect(billingPeriodKeyFor(new Date(august.end.getTime() - 1), LA)).toBe("2026-08");
  });
});

describe("period arithmetic", () => {
  it("steps backwards and forwards within a year", () => {
    expect(previousBillingPeriodKey("2026-08")).toBe("2026-07");
    expect(nextBillingPeriodKey("2026-08")).toBe("2026-09");
  });

  it("rolls December into January", () => {
    expect(nextBillingPeriodKey("2026-12")).toBe("2027-01");
    expect(nextBillingPeriod("2026-12", LA).label).toBe("January 2027");
  });

  it("rolls January back into December", () => {
    expect(previousBillingPeriodKey("2026-01")).toBe("2025-12");
    expect(previousBillingPeriod("2026-01", LA).label).toBe("December 2025");
  });

  it("round-trips", () => {
    for (const key of ["2026-01", "2026-06", "2026-12"]) {
      expect(previousBillingPeriodKey(nextBillingPeriodKey(key))).toBe(key);
    }
  });

  it("tracks the current month from a supplied instant", () => {
    const period = currentBillingPeriod(LA, new Date("2026-08-21T18:00:00Z"));
    expect(period.key).toBe("2026-08");
    expect(period.month).toBe(8);
    expect(period.year).toBe(2026);
  });
});

describe("day buckets", () => {
  it("names the local day, not the UTC one", () => {
    // 07:00Z on 21 August is midnight Pacific -- the start of the 21st.
    expect(billingDayKeyFor(new Date("2026-08-21T07:00:00Z"), LA)).toBe("2026-08-21");
    // 06:59Z is still the 20th locally, though UTC has already moved on.
    expect(billingDayKeyFor(new Date("2026-08-21T06:59:00Z"), LA)).toBe("2026-08-20");
  });

  it("gives a 25-hour day when the clocks go back", () => {
    // DST ends on Sunday 1 November 2026.
    const { start, end } = billingDayRange("2026-11-01", LA);
    expect(hours(end.getTime() - start.getTime())).toBe(25);
  });

  it("gives a 23-hour day when the clocks go forward", () => {
    // DST starts on Sunday 8 March 2026.
    const { start, end } = billingDayRange("2026-03-08", LA);
    expect(hours(end.getTime() - start.getTime())).toBe(23);
  });

  it("gives a 24-hour day the rest of the year", () => {
    const { start, end } = billingDayRange("2026-08-21", LA);
    expect(hours(end.getTime() - start.getTime())).toBe(24);
  });

  it("hands over cleanly at a month boundary", () => {
    const lastDay = billingDayRange("2026-08-31", LA);
    expect(lastDay.end.toISOString()).toBe(billingPeriod("2026-09", LA).start.toISOString());
  });

  it("lists every calendar day in the period", () => {
    const days = billingPeriodDayKeys(billingPeriod("2026-02", LA));
    expect(days).toHaveLength(28);
    expect(days[0]).toBe("2026-02-01");
    expect(days.at(-1)).toBe("2026-02-28");
  });

  it("handles a leap February", () => {
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(billingPeriodDayKeys(billingPeriod("2028-02", LA))).toHaveLength(29);
  });

  it("sorts lexicographically, which the chart relies on", () => {
    const days = billingPeriodDayKeys(billingPeriod("2026-08", LA));
    expect([...days].sort()).toEqual(days);
  });

  it("formats a short axis label", () => {
    expect(formatDayKeyShort("2026-08-01")).toBe("Aug 1");
    expect(formatDayKeyShort("2026-12-25")).toBe("Dec 25");
  });
});

describe("validation", () => {
  it("rejects a malformed period key", () => {
    for (const bad of ["2026-13", "2026-00", "26-08", "2026/08", "august"]) {
      expect(() => billingPeriod(bad, LA)).toThrow(InvalidBillingPeriodError);
    }
  });

  it("rejects an unknown timezone rather than silently shifting the boundary", () => {
    expect(() => assertValidTimeZone("Mars/Olympus_Mons")).toThrow(/Unknown billing timezone/);
    expect(() => billingPeriod("2026-08", "Mars/Olympus_Mons")).toThrow(/Unknown billing timezone/);
  });

  it("labels months in English regardless of the host locale", () => {
    expect(billingPeriodLabel("2026-01")).toBe("January 2026");
    expect(billingPeriodLabel("2026-12")).toBe("December 2026");
  });
});
