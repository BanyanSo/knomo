import test from "node:test";
import assert from "node:assert/strict";

import { RecordStatsViewStateController } from "../src/ui/RecordStatsViewStateController";

test("record stats view state starts with week view and a cloned selected date", () => {
	const initialDate = new Date(2024, 3, 15);
	const controller = new RecordStatsViewStateController(initialDate);
	initialDate.setFullYear(2020);

	const snapshot = controller.getSnapshot();
	assert.equal(snapshot.view, "week");
	assert.deepEqual(toDateParts(snapshot.selectedDate), [2024, 4, 15]);

	snapshot.selectedDate.setFullYear(2019);
	assert.deepEqual(toDateParts(controller.getSnapshot().selectedDate), [2024, 4, 15]);
});

test("record stats view state tracks rendered keys until explicitly cleared", () => {
	const controller = new RecordStatsViewStateController(new Date(2024, 3, 15));

	assert.equal(controller.isRendered("state-a"), false);
	controller.markRendered("state-a");
	assert.equal(controller.isRendered("state-a"), true);
	assert.equal(controller.isRendered("state-b"), false);
	controller.clearRendered();
	assert.equal(controller.isRendered("state-a"), false);
});

test("record stats view state changes views only when the value differs", () => {
	const controller = new RecordStatsViewStateController(new Date(2024, 3, 15));

	assert.equal(controller.setView("week"), false);
	assert.equal(controller.setView("month"), true);
	assert.equal(controller.setView("month"), false);
	assert.equal(controller.getSnapshot().view, "month");
});

test("record stats view state moves to previous and next periods", () => {
	const controller = new RecordStatsViewStateController(new Date(2024, 3, 15));

	assert.equal(controller.goToPrevious(2021), true);
	assert.deepEqual(toDateParts(controller.getSnapshot().selectedDate), [2024, 4, 8]);
	assert.equal(controller.goToNext(), true);
	assert.deepEqual(toDateParts(controller.getSnapshot().selectedDate), [2024, 4, 15]);

	assert.equal(controller.setView("month"), true);
	assert.equal(controller.goToPrevious(2021), true);
	assert.deepEqual(toDateParts(controller.getSnapshot().selectedDate), [2024, 3, 1]);
});

test("record stats view state blocks retreat before the earliest year", () => {
	const controller = new RecordStatsViewStateController(new Date(2020, 11, 28));

	assert.equal(controller.goToPrevious(2021), false);
	assert.deepEqual(toDateParts(controller.getSnapshot().selectedDate), [2020, 12, 28]);
});

function toDateParts(date: Date): [number, number, number] {
	return [date.getFullYear(), date.getMonth() + 1, date.getDate()];
}
