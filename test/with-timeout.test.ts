import { afterEach, describe, expect, test, vi } from "vitest";
import { TimeoutError, withTimeout } from "../src/with-timeout";

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("resolves with the value when the promise settles before the timeout", async () => {
    vi.useFakeTimers();
    const promise = withTimeout(Promise.resolve("ok"), 1000, "test-op");
    await expect(promise).resolves.toBe("ok");
  });

  test("rejects with TimeoutError when the promise exceeds the timeout", async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {
      /* never settles */
    });
    const promise = withTimeout(never, 1000, "snapshot");

    const assertion = expect(promise).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  test("TimeoutError message includes the operation label", async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {
      /* never settles */
    });
    const promise = withTimeout(never, 500, "PROPFIND /notes");

    const assertion = expect(promise).rejects.toThrow("PROPFIND /notes");
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  test("clears the timer when the promise resolves to avoid dangling timers", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    await withTimeout(Promise.resolve(42), 1000, "op");
    expect(clearSpy).toHaveBeenCalled();
  });
});
