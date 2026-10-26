import assert from "node:assert/strict";
import { createSearchScheduler } from "./src/search-scheduler.js";
const tick = () => new Promise(resolve => setTimeout(resolve, 12));
const deferred = new Map(), calls = [], shown = [], errors = [];
let active = 0, maxActive = 0;
const queue = createSearchScheduler({ delayMs: 3,
  search(query) {
    calls.push(query); active++;maxActive=Math.max(maxActive,active);
    return new Promise((resolve,reject)=>deferred.set(query,{
      resolve:value=>{active--;resolve(value);},reject:error=>{active--;reject(error);},
    }));
  },
  onResult:(value,query,context)=>shown.push({value,query,context}),
  onError:(error,query)=>errors.push({error:error.message,query}),
});
const first=queue.schedule("first",1);await tick();
const skipped=queue.schedule("middle",2);await tick();
const latest=queue.schedule("latest",3);await tick();
assert.deepEqual(calls,["first"]);assert.equal(active,1);
deferred.get("first").resolve(["old"]);assert.equal(await first,"cancelled");
await tick();assert.deepEqual(calls,["first","latest"]);assert.equal(await skipped,"cancelled");
deferred.get("latest").resolve(["new"]);assert.equal(await latest,"completed");
assert.deepEqual(shown,[{value:["new"],query:"latest",context:3}]);assert.equal(maxActive,1);
// Closing/clearing/composition cancel both the waiting keyword and old responses.
const stale=queue.schedule("stale",4);await tick();
const pending=queue.schedule("must-not-run",5);queue.cancel();
assert.equal(await pending,"cancelled");
deferred.get("stale").reject(new Error("stale failure"));assert.equal(await stale,"cancelled");
await tick();assert.deepEqual(errors,[]);assert.equal(shown.length,1);assert.ok(!calls.includes("must-not-run"));
const after=queue.schedule("reopened",6);await tick();
deferred.get("reopened").resolve(["fresh"]);assert.equal(await after,"completed");assert.equal(shown.at(-1).query,"reopened");
console.log("search scheduler: debounce, one in flight, latest-only pending, stale success/error, cancellation and reopening passed");
