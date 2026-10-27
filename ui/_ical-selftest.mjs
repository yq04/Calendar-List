import assert from "node:assert/strict";
import { parseIcsCalendar, parseIcsCalendarDetailed } from "./src/nlp-parser.js";
import { buildIcsCalendar } from "./src/calendar.js";

const calendar = (...events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join("")}END:VCALENDAR\r\n`;
const event = (...props) => `BEGIN:VEVENT\r\n${props.join("\r\n")}\r\nEND:VEVENT\r\n`;
const parse = (...props) => parseIcsCalendarDetailed(calendar(event("SUMMARY:测试", ...props)));

assert.deepEqual(parse("DTSTART:20261027T130000").items, [{ date: "2026-10-27", time: "13:00", title: "测试", kind: "event" }]);
assert.deepEqual(parse("DTSTART;VALUE=DATE:20261027", "DTEND;VALUE=DATE:20261028").items, [{ date: "2026-10-27", time: "", title: "测试", kind: "event" }]);
for (const props of [
  ["DTSTART:20261027T130000Z"],
  ["DTSTART;TZID=Asia/Shanghai:20261027T130000"],
  ["DTSTART:20261027T130001"],
  ["DTSTART:20261027T130000", "DTEND:20261027T140000"],
  ["DTSTART;VALUE=DATE:20261027", "DTEND;VALUE=DATE:20261029"],
  ["DTSTART:20261027T130000", "RRULE:FREQ=DAILY"],
  ["DTSTART:20261027T130000", "RECURRENCE-ID:20261027T130000"],
  ["DTSTART:20260230T130000"],
]) {
  const result = parse(...props);
  assert.equal(result.items.length, 0, props.join(" "));
  assert.ok(result.skipped[0].reason);
}
const same = event("SUMMARY:重复", "DTSTART:20261027T130000", "UID:same");
assert.equal(parseIcsCalendarDetailed(calendar(same)).items[0].uid, "same");
assert.equal(parseIcsCalendarDetailed(calendar(same, same)).skipped.length, 2);
assert.ok(parse("DTSTART:20261027T130000", "DESCRIPTION:备注").warnings.length);
assert.ok(parseIcsCalendarDetailed("BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:坏").errors.length);
assert.ok(parseIcsCalendarDetailed(calendar(same).replace("VERSION:2.0", "VERSION:2.0\r\nMETHOD:CANCEL")).errors.length);
const output = buildIcsCalendar([{ date: "2026-10-27", time: "23:59", title: "测试" }, { date: "2026-10-28", title: "全天" }]);
assert.deepEqual(parseIcsCalendar(output).map(({ date, time, kind }) => ({ date, time, kind })), [
  { date: "2026-10-27", time: "23:59", kind: "event" }, { date: "2026-10-28", time: "", kind: "event" },
]);
console.log("ICS subset tests passed");
