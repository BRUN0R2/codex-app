import { describe, expect, it } from "vitest";

import { InitializationTimeoutError } from "./initializationTimeout";

describe("initialization timeout", () => {
  it("is an Error identifiable by its name", () => {
    const timeout = new InitializationTimeoutError("timed out");
    expect(timeout).toBeInstanceOf(Error);
    expect(timeout.name).toBe("InitializationTimeoutError");
    expect(timeout.message).toBe("timed out");
  });
});
