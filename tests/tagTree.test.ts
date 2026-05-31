import test from "node:test";
import assert from "node:assert/strict";

import { buildTagTree } from "../src/utils/tagTree";
import { buildTagDisplayMap, normalizeTagKey } from "../src/utils/tags";

test("normalizes tag keys without cleaning valid tag characters", () => {
	assert.equal(normalizeTagKey("#Life/健康+😀 "), "life/健康+😀");
	assert.equal(normalizeTagKey(" #情绪+"), "情绪+");
});

test("builds nested tag groups from slash tags", () => {
	assert.deepEqual(buildTagTree([
		{ key: "project/knomo/ui", name: "project/knomo/ui", count: 2 },
		{ key: "project/knomo/sync", name: "project/knomo/sync", count: 1 },
		{ key: "daily", name: "daily", count: 3 },
	]), [
		{ key: "daily", name: "daily", label: "daily", count: 3, children: [] },
		{
			key: "project",
			name: "project",
			label: "project",
			count: 3,
			children: [
				{
					key: "project/knomo",
					name: "project/knomo",
					label: "knomo",
					count: 3,
					children: [
						{ key: "project/knomo/ui", name: "project/knomo/ui", label: "ui", count: 2, children: [] },
						{ key: "project/knomo/sync", name: "project/knomo/sync", label: "sync", count: 1, children: [] },
					],
				},
			],
		},
	]);
});

test("adds direct tag counts to child group counts", () => {
	assert.deepEqual(buildTagTree([
		{ key: "project", name: "project", count: 1 },
		{ key: "project/knomo", name: "project/knomo", count: 2 },
	]), [
		{
			key: "project",
			name: "project",
			label: "project",
			count: 3,
			children: [
				{ key: "project/knomo", name: "project/knomo", label: "knomo", count: 2, children: [] },
			],
		},
	]);
});

test("merges tag tree nodes by normalized paths", () => {
	assert.deepEqual(buildTagTree([
		{ key: "life/健康", name: "Life/健康", count: 2 },
		{ key: "life/饮食", name: "life/饮食", count: 1 },
	]), [
		{
			key: "life",
			name: "Life",
			label: "Life",
			count: 3,
			children: [
				{ key: "life/健康", name: "Life/健康", label: "健康", count: 2, children: [] },
				{ key: "life/饮食", name: "life/饮食", label: "饮食", count: 1, children: [] },
			],
		},
	]);
});

test("chooses tag display casing by count and latest modified source", () => {
	const displayTags = buildTagDisplayMap([
		{ tag: "#life/健康", modifiedTime: 100, order: 0 },
		{ tag: "#Life/健康", modifiedTime: 200, order: 1 },
	]);
	assert.equal(displayTags.get("life"), "Life");
	assert.equal(displayTags.get("life/健康"), "Life/健康");

	const frequentTags = buildTagDisplayMap([
		{ tag: "#Life/健康", modifiedTime: 300, order: 0 },
		{ tag: "#life/健康", modifiedTime: 100, order: 1 },
		{ tag: "#life/健康", modifiedTime: 200, order: 2 },
	]);
	assert.equal(frequentTags.get("life"), "life");
	assert.equal(frequentTags.get("life/健康"), "life/健康");
});
