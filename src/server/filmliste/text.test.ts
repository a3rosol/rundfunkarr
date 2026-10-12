import { describe, expect, it } from "vitest";
import { buildMatchExpression, foldText, queryTokens, UnsupportedQueryError } from "./text";

describe("foldText", () => {
  it("folds umlauts like MediathekViewWeb and strips other accents", () => {
    expect(foldText("Die Höhle der Löwen – Straße, Café")).toBe(
      "die hoehle der loewen – strasse, cafe"
    );
  });
});

describe("queryTokens", () => {
  it("splits on everything except ASCII letters and digits", () => {
    expect(queryTokens("Tatort: Münster (S01/E02)")).toEqual(["tatort", "muenster", "s01", "e02"]);
    expect(queryTokens(" – ")).toEqual([]);
  });
});

describe("buildMatchExpression", () => {
  it("matches everything without queries", () => {
    expect(buildMatchExpression([])).toBeUndefined();
  });

  it("requires every word as a prefix in any of the fields", () => {
    expect(buildMatchExpression([{ fields: ["title", "topic"], query: "Höhle Löwen" }])).toBe(
      '(({title topic} : "hoehle"* AND {title topic} : "loewen"*))'
    );
  });

  it("combines queries on the same fields with OR and different fields with AND", () => {
    expect(
      buildMatchExpression([
        { fields: ["topic"], query: "Tatort" },
        { fields: ["topic"], query: "Polizeiruf" },
        { fields: ["channel"], query: "ARD" },
      ])
    ).toBe('(({topic} : "tatort"*) OR ({topic} : "polizeiruf"*)) AND (({channel} : "ard"*))');
  });

  it("matches nothing when a field group has no searchable words", () => {
    expect(
      buildMatchExpression([
        { fields: ["topic"], query: "Tatort" },
        { fields: ["channel"], query: "!!" },
      ])
    ).toBeNull();
  });

  it("rejects fields the local index does not cover", () => {
    expect(() => buildMatchExpression([{ fields: ["description"], query: "x" }])).toThrow(
      UnsupportedQueryError
    );
  });
});
