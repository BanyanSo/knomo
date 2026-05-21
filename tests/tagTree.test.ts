import test from "node:test";
import assert from "node:assert/strict";

import { buildTagTree } from "../src/utils/tagTree";

test("builds nested tag groups from slash tags", () => {
	assert.deepEqual(buildTagTree([
		{ name: "project/knomo/ui", count: 2 },
		{ name: "project/knomo/sync", count: 1 },
		{ name: "daily", count: 3 },
	]), [
		{ name: "daily", label: "daily", count: 3, children: [] },
		{
			name: "project",
			label: "project",
			count: 3,
			children: [
				{
					name: "project/knomo",
					label: "knomo",
					count: 3,
					children: [
						{ name: "project/knomo/ui", label: "ui", count: 2, children: [] },
						{ name: "project/knomo/sync", label: "sync", count: 1, children: [] },
					],
				},
			],
		},
	]);
});

test("adds direct tag counts to child group counts", () => {
	assert.deepEqual(buildTagTree([
		{ name: "project", count: 1 },
		{ name: "project/knomo", count: 2 },
	]), [
		{
			name: "project",
			label: "project",
			count: 3,
			children: [
				{ name: "project/knomo", label: "knomo", count: 2, children: [] },
			],
		},
	]);
});
