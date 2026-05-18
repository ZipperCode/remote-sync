import { describe, expect, test } from "vitest";
import { mergeCustomHeaders, parseCustomHeaders } from "../src/custom-headers";

describe("custom headers", () => {
  test("parses header lines and ignores blanks", () => {
    expect(parseCustomHeaders("User-Agent: RemoteSync\r\n\r\nX-Token: abc:123\n")).toEqual({
      "User-Agent": "RemoteSync",
      "X-Token": "abc:123"
    });
  });

  test("reports invalid lines with Chinese line number", () => {
    expect(() => parseCustomHeaders("X-Ok: 1\nbroken")).toThrow("第 2 行请求头格式错误");
  });

  test("rejects headers reserved by protocol or signing", () => {
    expect(() => parseCustomHeaders("Authorization: Bearer token")).toThrow(
      "第 1 行请求头不允许覆盖内置头：Authorization"
    );
    expect(() => parseCustomHeaders("x-amz-date: 20260101T000000Z")).toThrow(
      "第 1 行请求头不允许覆盖内置头：x-amz-date"
    );
  });

  test("keeps built-in headers authoritative when merging", () => {
    expect(
      mergeCustomHeaders(
        {
          Depth: "0",
          "X-Trace": "user"
        },
        {
          Depth: "1",
          Authorization: "Basic token"
        }
      )
    ).toEqual({
      Depth: "1",
      "X-Trace": "user",
      Authorization: "Basic token"
    });
  });
});
