import assert from "node:assert/strict";
import { createMockSource } from "./src/mock.js";
import { createBridge } from "./src/bridge.js";
import { getMonthMatrix, getMatrixMonths } from "./src/calendar.js";
const mock=createMockSource();
const canonical=items=>items.map(item=>({...item})).sort((a,b)=>a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
for(const [year,month,weekStart] of [[2026,9,1],[2026,11,0],[2028,1,1],[2027,0,0]]){
  const cells=getMonthMatrix(year,month,weekStart),start=cells[0].key,end=cells.at(-1).key;
  await mock.itemCreate(start,"边界日期开始");await mock.itemCreate(end,"边界日期结束");
  const range=await mock.rangeEvents(start,end);
  const months=(await Promise.all(getMatrixMonths(cells).map(m=>mock.monthEvents(m.year,m.month)))).flat().filter(item=>item.date>=start&&item.date<=end);
  assert.deepEqual(canonical(range),canonical(months),"42 dates must match month reads filtered to visible dates");
  assert.ok(range.some(item=>item.date===start));assert.ok(range.some(item=>item.date===end));
}
await assert.rejects(mock.rangeEvents("2026-02-30","2026-03-05"),/日期/);
await assert.rejects(mock.rangeEvents("2026-03-05","2026-03-04"),/范围/);
await assert.rejects(mock.rangeEvents("2026-01-01","2026-04-04"),/范围/);
await mock.rangeEvents("2026-01-01","2026-04-03");
const calls=[];const shell=await createBridge({invoke:async(cmd,args)=>{calls.push({cmd,args});return cmd==="range_events"?[]:{};}});
await shell.rangeEvents("2026-09-28","2026-11-08");
assert.deepEqual(calls.at(-1),{cmd:"range_events",args:{start:"2026-09-28",end:"2026-11-08"}});
assert.equal(typeof shell.monthEvents,"function");assert.equal(typeof (await createBridge()).rangeEvents,"function");
console.log("range reads: visible-date equivalence, inclusive edges, leap/year boundaries, real date/93-day validation and IPC passed");
