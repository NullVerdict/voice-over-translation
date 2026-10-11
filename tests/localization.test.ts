import { describe, expect, test } from "bun:test";
import { formatTranslationEta } from "../src/utils/timeFormatting.ts";

const locales = {
  translationTakeMoreThanHour: "Перевод займёт больше часа",
  translationTakeAboutMinute: "Перевод займёт около минуты",
  translationTakeFewMinutes: "Перевод займёт несколько минут",
  translationTakeApproximatelyMinutes: "Перевод займёт примерно {0} минут",
  translationTakeApproximatelyMinute: "Перевод займёт примерно {0} минуты",
  translationTakeApproximatelyMinute2: "Перевод займёт примерно {0} минуту",
} as const;

const localizationProvider = {
  get: (message: keyof typeof locales) => locales[message] ?? message,
};

const t = localizationProvider.get;

function secsToStrTime(secs: number) {
  return formatTranslationEta(secs, (key) => t(key));
}

describe("secs to str time", () => {
  test.each([30, 60, 90])("%d sec", (secs) => {
    const result = secsToStrTime(secs);
    const expected = t("translationTakeAboutMinute");
    expect(result).toBe(expected);
  });
  test.each([100, 120])("%d sec", (secs) => {
    const result = secsToStrTime(secs);
    const expected = localizationProvider
      .get("translationTakeApproximatelyMinute")
      .replace("{0}", "2");
    expect(result).toBe(expected);
  });
  test("280 sec", () => {
    const result = secsToStrTime(280);
    const expected = localizationProvider
      .get("translationTakeApproximatelyMinutes")
      .replace("{0}", "5");
    expect(result).toBe(expected);
  });
  test("300 sec", () => {
    const result = secsToStrTime(300);
    const expected = localizationProvider
      .get("translationTakeApproximatelyMinutes")
      .replace("{0}", "5");
    expect(result).toBe(expected);
  });
  test("3587 sec", () => {
    const result = secsToStrTime(3587);
    const expected = t("translationTakeMoreThanHour");
    expect(result).toBe(expected);
  });
  test("1240 sec", () => {
    const result = secsToStrTime(1240);
    const expected = localizationProvider
      .get("translationTakeApproximatelyMinute2")
      .replace("{0}", "21");
    expect(result).toBe(expected);
  });
});
