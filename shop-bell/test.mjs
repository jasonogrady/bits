// node test.mjs — the one check that fails if the alert logic breaks.
import assert from "node:assert/strict";
import { visitNote, isBot } from "./worker.js";
const cf = { city: "Portland", region: "Oregon", country: "US", asOrganization: "Comcast" };
const s = { id: "x", ua: "Mozilla/5.0 Safari", referrer: "https://news.ycombinator.com/" };
let n = visitNote({ event: "page_view", props: { new: true }, path: "/", session: s }, cf, "example.com");
assert.equal(n.title, "👀 Visit — example.com/"); assert.equal(n.priority, "default"); assert.equal(n.url, "https://example.com/");
assert.match(n.body, /Org: Comcast\nFrom: Portland, Oregon, US\nRef: https:\/\/news/);
n = visitNote({ event: "page_view", path: "/pricing", session: s }, cf, "example.com");
assert.equal(n.title, "📄 example.com/pricing"); assert.equal(n.priority, "low");
n = visitNote({ event: "qualified_lead", props: { trigger: "goal_view" }, path: "/contact", session: s }, {}, "example.com");
assert.equal(n.priority, "high"); assert.match(n.body, /trigger: goal_view/);
n = visitNote({ event: "demo_started", props: { plan: "pro" }, path: "/", session: s }, {}, "example.com");
assert.equal(n.title, "⚡ demo_started — example.com/"); assert.match(n.body, /plan: pro/);
assert.ok(isBot("Googlebot/2.1") && !isBot("Mozilla/5.0 (iPhone) Safari"));
console.log("ok");
