import test from "node:test";
import assert from "node:assert/strict";
import { placeMobileMenu } from "../src/ui/mobileMenuGeometry";

const bounds = { left: 12, right: 308, top: 12, bottom: 600 };
test("menu placement preserves its anchor, flips at the bottom and clamps horizontal edges", () => {
	const upper = placeMobileMenu({ left: 280, right: 310, top: 40, bottom: 84 }, bounds, 200, 300, 58, true)!;
	assert.equal(upper.opensAbove, false); assert.equal(upper.top, 90); assert.equal(upper.left, 108);
	const lower = placeMobileMenu({ left: 280, right: 310, top: 530, bottom: 574 }, bounds, 200, 300, 58, true)!;
	assert.equal(lower.opensAbove, true); assert.equal(lower.top, 224);
});
test("both sides constrained uses the larger side; missing anchor or less than one row closes safely", () => {
	const middle = placeMobileMenu({ left: 20, right: 60, top: 250, bottom: 294 }, bounds, 200, 900, 58, false)!;
	assert.equal(middle.opensAbove, false); assert.equal(middle.maxHeight, 300);
	assert.equal(placeMobileMenu({ left: 20, right: 60, top: 610, bottom: 654 }, bounds, 200, 300, 58, false), null);
	assert.equal(placeMobileMenu({ left: 20, right: 60, top: 30, bottom: 74 }, { ...bounds, bottom: 120 }, 200, 300, 58, false), null);
});
