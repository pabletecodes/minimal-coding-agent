import { test } from "node:test";
import assert from "node:assert/strict";
import { subtract, multiply, divide } from "./calculator.js";

test("subtract", () => {
  assert.equal(subtract(5, 3), 2);
});

test("multiply", () => {
  assert.equal(multiply(4, 3), 12);
});

test("divide", () => {
  assert.equal(divide(10, 2), 5);
  assert.throws(() => divide(1, 0));
});
