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
  const cases: Array<[string, number, string]> = [
    ["30 sec", 30, t("translationTakeAboutMinute")],
    ["60 sec", 60, t("translationTakeAboutMinute")],
    ["90 sec", 90, t("translationTakeAboutMinute")],
    [
      "100 sec",
      100,
      localizationProvider
        .get("translationTakeApproximatelyMinute")
        .replace("{0}", "2"),
    ],
    [
      "120 sec",
      120,
      localizationProvider
        .get("translationTakeApproximatelyMinute")
        .replace("{0}", "2"),
    ],
    [
      "280 sec",
      280,
      localizationProvider
        .get("translationTakeApproximatelyMinutes")
        .replace("{0}", "5"),
    ],
    [
      "300 sec",
      300,
      localizationProvider
        .get("translationTakeApproximatelyMinutes")
        .replace("{0}", "5"),
    ],
    ["3587 sec", 3587, t("translationTakeMoreThanHour")],
    [
      "1240 sec",
      1240,
      localizationProvider
        .get("translationTakeApproximatelyMinute2")
        .replace("{0}", "21"),
    ],
  ];

  test.each(cases)("%s", (_label, seconds, expected) => {
    expect(secsToStrTime(seconds)).toBe(expected);
  });
});
