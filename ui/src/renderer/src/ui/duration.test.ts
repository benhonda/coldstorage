/**
 * The app's one duration phrase. Every case here is a way it could read as a bug to a user: a plural that
 * doesn't agree, a "60 minutes left" that should have been an hour, a "24 hours left" that should have
 * been a day.
 */
import { describe, expect, test } from "bun:test";
import { timeLeft, timeLeftSentence } from "./duration.ts";

const MIN = 60;
const HOUR = 3600;

describe("timeLeft", () => {
  test("says nothing when there's nothing worth saying", () => {
    expect(timeLeft(Number.NaN)).toBe("");
    expect(timeLeft(Number.POSITIVE_INFINITY)).toBe("");
    expect(timeLeft(-1)).toBe("");
  });

  test("under a minute doesn't count seconds", () => {
    expect(timeLeft(0)).toBe("under a minute left");
    expect(timeLeft(59)).toBe("under a minute left");
  });

  test("minutes: nearest minute up close, nearest 5 further out", () => {
    expect(timeLeft(60)).toBe("about 1 minute left");
    expect(timeLeft(5 * MIN)).toBe("about 5 minutes left");
    expect(timeLeft(23 * MIN)).toBe("about 25 minutes left");
  });

  test("minutes never round up into a bogus '60 minutes'", () => {
    // 58 minutes rounds to the nearest 5 → 60, which has to become an hour rather than read as minutes.
    expect(timeLeft(58 * MIN)).toBe("about 1 hour left");
  });

  test("hours round to the half, and a half is always plural", () => {
    expect(timeLeft(HOUR)).toBe("about 1 hour left");
    expect(timeLeft(90 * MIN)).toBe("about 1½ hours left");
    expect(timeLeft(5 * HOUR)).toBe("about 5 hours left");
  });

  test("the day boundary has no gap — nothing reads as '24 hours left'", () => {
    expect(timeLeft(23 * HOUR + 50 * MIN)).toBe("about 1 day left");
    expect(timeLeft(24 * HOUR)).toBe("about 1 day left");
  });

  test("days carry their leftover hours, and drop them when flat", () => {
    expect(timeLeft(41 * HOUR)).toBe("about 1 day 17 hours left");
    expect(timeLeft(25 * HOUR)).toBe("about 1 day 1 hour left");
    expect(timeLeft(48 * HOUR)).toBe("about 2 days left");
  });
});

describe("timeLeftSentence", () => {
  test("capitalises for a standalone line, and stays empty when there's no estimate", () => {
    expect(timeLeftSentence(41 * HOUR)).toBe("About 1 day 17 hours left");
    expect(timeLeftSentence(-1)).toBe("");
  });
});
