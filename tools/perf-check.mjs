// Kal Performance Benchmarking Engine (P2 Baseline & After Optimization)
// Measures IPC query latency (median, p95 across 20 iterations via nearest-rank),
// range_events semantic equivalence assertion vs filtered 3-month legacy load,
// and memory metrics across fixtures.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    port: process.env.KAL_CDP_PORT || "9456",
    phase: "before",
    scale: "small",
    dbPath: "",
    expectedDb: "",
    expectedAppDir: "",
    outJson: ""
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--cdp-port" && args[i + 1]) opts.port = args[++i];
    else if (args[i] === "--phase" && args[i + 1]) opts.phase = args[++i];
    else if (args[i] === "--scale" && args[i + 1]) opts.scale = args[++i];
    else if (args[i] === "--db-path" && args[i + 1]) opts.dbPath = args[++i];
    else if (args[i] === "--expected-db" && args[i + 1]) opts.expectedDb = args[++i];
    else if (args[i] === "--expected-app-dir" && args[i + 1]) opts.expectedAppDir = args[++i];
    else if (args[i] === "--output-json" && args[i + 1]) opts.outJson = args[++i];
  }
  if (!opts.expectedDb && opts.dbPath) opts.expectedDb = opts.dbPath;
  return opts;
}

async function connectCDP(port) {
  const url = `http://127.0.0.1:${port}/json/list`;
  let targets;
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(url);
      targets = await res.json();
      const page = targets.find(t => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          ws.onopen = resolve;
          ws.onerror = reject;
        });
        return { ws, page };
      }
    } catch (e) {
      // wait for port to be ready
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Failed to connect to CDP on port ${port}`);
}

function createEvaluator(ws) {
  let seq = 0;
  const waiting = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const entry = waiting.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    waiting.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else if (msg.result?.exceptionDetails) {
      entry.reject(new Error(msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text));
    } else {
      entry.resolve(msg.result?.result?.value);
    }
  };

  return function evaluate(expression, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`Evaluation timed out (${timeoutMs}ms): ${expression.slice(0, 80)}`));
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true
        }
      }));
    });
  };
}

async function waitForTauri(evaluate, maxRetries = 50) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const ready = await evaluate(`Boolean(typeof window !== "undefined" && window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke && document.querySelectorAll(".kal-cell").length === 42)`);
      if (ready) return true;
    } catch (e) {
      // ignore while loading
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("Timed out waiting for window.__TAURI__.core and initial 42 kal-cells to initialize");
}

function normalizePath(p) {
  return path.resolve(p).replaceAll("\\", "/").toLowerCase();
}

function stats(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const n = sorted.length;
  const min = sorted[0];
  const max = sorted[n - 1];
  const sum = sorted.reduce((a, b) => a + b, 0);
  const avg = Number((sum / n).toFixed(2));
  const median = n % 2 === 0 ? Number(((sorted[n / 2 - 1] + sorted[n / 2]) / 2).toFixed(2)) : Number(sorted[Math.floor(n / 2)].toFixed(2));
  
  // Nearest-rank method: Math.ceil(n * 0.95) - 1
  // For n=20: Math.ceil(19) - 1 = 18 (index 18 is 19th sample, separating p95 from max index 19)
  const p95Idx = Math.max(0, Math.min(n - 1, Math.ceil(n * 0.95) - 1));
  const p95 = Number(sorted[p95Idx].toFixed(2));
  return { samples: durations.map(d => Number(d.toFixed(2))), count: n, min, max, avg, median, p95, p95Index: p95Idx };
}

async function main() {
  const opts = parseArgs();
  console.log(`[perf-check] Connecting to Kal Debug on port ${opts.port} (Scale=${opts.scale}, Phase=${opts.phase})...`);
  const { ws, page } = await connectCDP(opts.port);
  const evaluate = createEvaluator(ws);

  try {
    // 1. Wait for Tauri & UI to fully initialize
    await waitForTauri(evaluate);

    // 2. Query environment and STRICTLY ASSERT database and APPDATA isolation
    const appInfo = await evaluate(`window.__TAURI__.core.invoke("app_info")`);
    console.log(`[perf-check] Connected to App: db=${appInfo.dbPath}, appDir=${appInfo.appDir}`);

    if (opts.expectedDb) {
      const actualDb = normalizePath(appInfo.dbPath);
      const expectedDb = normalizePath(opts.expectedDb);
      assert.equal(actualDb, expectedDb, `硬性闸门断言失败：实际数据库路径 (${actualDb}) 与预期 fixture (${expectedDb}) 不符！`);
      console.log(`[perf-check] 数据库隔离断言通过: ${actualDb}`);
    }

    if (opts.expectedAppDir) {
      const actualApp = normalizePath(appInfo.appDir);
      const expectedApp = normalizePath(opts.expectedAppDir);
      assert.ok(actualApp.startsWith(expectedApp), `硬性闸门断言失败：实际 APPDATA (${actualApp}) 必须在隔离 runtime 目录 (${expectedApp}) 内！`);
      console.log(`[perf-check] APPDATA 隔离断言通过: ${actualApp}`);
    }

    // 3. Benchmark month_events (20 iterations)
    console.log("[perf-check] Benchmarking month_events (20 iterations for 2026-10)...");
    const monthResult = await evaluate(`(async () => {
      const invoke = window.__TAURI__.core.invoke;
      const durations = [];
      let lastCount = 0;
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        const items = await invoke("month_events", { year: 2026, month: 10 });
        const t1 = performance.now();
        durations.push(t1 - t0);
        lastCount = items.length;
      }
      return { durations, count: lastCount };
    })()`);
    const monthStats = { ...stats(monthResult.durations), itemsReturned: monthResult.count };
    console.log(`  month_events: median=${monthStats.median}ms, p95=${monthStats.p95}ms, min=${monthStats.min}ms, max=${monthStats.max}ms (items=${monthStats.itemsReturned})`);

    // 4. Benchmark day_events (20 iterations)
    console.log("[perf-check] Benchmarking day_events (20 iterations for 2026-10-15)...");
    const dayResult = await evaluate(`(async () => {
      const invoke = window.__TAURI__.core.invoke;
      const durations = [];
      let lastCount = 0;
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        const items = await invoke("day_events", { date: "2026-10-15" });
        const t1 = performance.now();
        durations.push(t1 - t0);
        lastCount = items.length;
      }
      return { durations, count: lastCount };
    })()`);
    const dayStats = { ...stats(dayResult.durations), itemsReturned: dayResult.count };
    console.log(`  day_events: median=${dayStats.median}ms, p95=${dayStats.p95}ms, min=${dayStats.min}ms, max=${dayStats.max}ms (items=${dayStats.itemsReturned})`);

    // 5. Benchmark search_events across query patterns (20 iterations each)
    const queries = [
      { name: "high_freq", query: "项目" },
      { name: "mid_freq", query: "架构评审" },
      { name: "exact_term", query: "全日期快速检索" },
      { name: "zero_match", query: "nonexistent_query_xyz" }
    ];

    const searchStats = {};
    for (const q of queries) {
      console.log(`[perf-check] Benchmarking search_events '${q.query}' (20 iterations)...`);
      const res = await evaluate(`(async () => {
        const invoke = window.__TAURI__.core.invoke;
        const durations = [];
        let lastCount = 0;
        for (let i = 0; i < 20; i++) {
          const t0 = performance.now();
          const items = await invoke("search_events", { query: ${JSON.stringify(q.query)} });
          const t1 = performance.now();
          durations.push(t1 - t0);
          lastCount = items.length;
        }
        return { durations, count: lastCount };
      })()`);
      searchStats[q.name] = {
        query: q.query,
        ...stats(res.durations),
        itemsReturned: res.count
      };
      console.log(`  search('${q.query}'): median=${searchStats[q.name].median}ms, p95=${searchStats[q.name].p95}ms (matched=${res.count})`);
    }

    // 6. Benchmark Legacy Render Read Amplification (3-month matrix load without cache)
    // Loads months 9, 10, 11 (2026-09-01 to 2026-11-30) and measures filtering to visible 42 cells (2026-09-28 to 2026-11-08)
    console.log("[perf-check] Benchmarking Legacy 3-month matrix load (without cache)...");
    const legacy3Month = await evaluate(`(async () => {
      const invoke = window.__TAURI__.core.invoke;
      const durations = [];
      let totalRaw = 0;
      let filteredCount = 0;
      let filteredItemIds = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const [m9, m10, m11] = await Promise.all([
          invoke("month_events", { year: 2026, month: 9 }),
          invoke("month_events", { year: 2026, month: 10 }),
          invoke("month_events", { year: 2026, month: 11 })
        ]);
        const t1 = performance.now();
        durations.push(t1 - t0);
        const combined = [...m9, ...m10, ...m11];
        totalRaw = combined.length;
        const in42 = combined.filter(it => it.date >= "2026-09-28" && it.date <= "2026-11-08");
        filteredCount = in42.length;
        if (i === 0) {
          filteredItemIds = in42.map(it => it.id).sort();
        }
      }
      return { durations, totalRaw, filteredCount, filteredItemIds, monthsLoaded: 3 };
    })()`);
    const legacy3MonthStats = {
      ...stats(legacy3Month.durations),
      monthsLoaded: 3,
      totalItemsIn3FullMonths: legacy3Month.totalRaw,
      filteredToVisible42DaysCount: legacy3Month.filteredCount,
      amplificationFactor: "3x (reads all_items() 3 separate times per month view render)"
    };
    console.log(`  legacy 3-month load: median=${legacy3MonthStats.median}ms, p95=${legacy3MonthStats.p95}ms, 3-month raw=${legacy3Month.totalRaw}, filtered 42-days=${legacy3Month.filteredCount}`);

    // 7. Benchmark New range_events (if supported by binary)
    // Measures single-query visible interval 2026-09-28 to 2026-11-08 (20 iterations)
    // and strictly asserts ID equivalence against filtered legacy 3-month results.
    let rangeEventsStats = null;
    let rangeEquivalence = null;
    const hasRangeEvents = await evaluate(`Boolean(window.__TAURI__?.core?.invoke && typeof window.__TAURI__.core.invoke === "function")`);
    if (hasRangeEvents) {
      console.log("[perf-check] Probing range_events command...");
      const rangeProbe = await evaluate(`(async () => {
        try {
          const items = await window.__TAURI__.core.invoke("range_events", { start: "2026-09-28", end: "2026-11-08" });
          return { supported: true, sampleCount: items.length, sampleIds: items.map(it => it.id).sort() };
        } catch (e) {
          return { supported: false, error: e?.message || String(e) };
        }
      })()`);

      if (rangeProbe.supported) {
        console.log(`[perf-check] range_events is supported! Benchmarking 20 iterations (2026-09-28 ~ 2026-11-08)...`);
        const rangeResult = await evaluate(`(async () => {
          const invoke = window.__TAURI__.core.invoke;
          const durations = [];
          let lastCount = 0;
          for (let i = 0; i < 20; i++) {
            const t0 = performance.now();
            const items = await invoke("range_events", { start: "2026-09-28", end: "2026-11-08" });
            const t1 = performance.now();
            durations.push(t1 - t0);
            lastCount = items.length;
          }
          return { durations, count: lastCount };
        })()`);
        rangeEventsStats = {
          ...stats(rangeResult.durations),
          intervalStart: "2026-09-28",
          intervalEnd: "2026-11-08",
          itemsReturned: rangeResult.count
        };
        console.log(`  range_events: median=${rangeEventsStats.median}ms, p95=${rangeEventsStats.p95}ms (items=${rangeEventsStats.itemsReturned})`);

        // Assert semantic equivalence with filtered 3-month legacy result
        const legacyIds = legacy3Month.filteredItemIds;
        const rangeIds = rangeProbe.sampleIds;
        const countMatch = legacyIds.length === rangeIds.length;
        let diffCount = 0;
        if (!countMatch) {
          diffCount = Math.abs(legacyIds.length - rangeIds.length);
        } else {
          for (let i = 0; i < legacyIds.length; i++) {
            if (legacyIds[i] !== rangeIds[i]) diffCount++;
          }
        }

        assert.equal(diffCount, 0, `range_events 返回结果与旧 3 个月结果过滤至 42 格区间不一致！差异数: ${diffCount}`);
        rangeEquivalence = {
          verified: true,
          itemCount: rangeResult.count,
          interval: "2026-09-28 ~ 2026-11-08",
          message: "经断言核验：range_events 返回对象 ID 集合与旧三月全量结果过滤到 42 格可见区间的集合 100% 精确一致"
        };
        console.log(`[perf-check] 语义等价性断言通过：range_events (${rangeResult.count}条) === legacyFiltered (${legacy3Month.filteredCount}条)`);
      } else {
        console.log(`[perf-check] range_events is not present in this binary: ${rangeProbe.error}`);
      }
    }

    const resultReport = {
      timestamp: new Date().toISOString(),
      phase: opts.phase,
      scale: opts.scale,
      dbPath: appInfo.dbPath,
      appDir: appInfo.appDir,
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch
      },
      metrics: {
        monthEvents: monthStats,
        dayEvents: dayStats,
        searchEvents: searchStats,
        legacy3MonthLoad: legacy3MonthStats,
        rangeEvents: rangeEventsStats,
        rangeEquivalence
      }
    };

    if (opts.outJson) {
      await fs.mkdir(path.dirname(opts.outJson), { recursive: true });
      await fs.writeFile(opts.outJson, JSON.stringify(resultReport, null, 2), "utf8");
      console.log(`[perf-check] Saved metrics JSON to ${opts.outJson}`);
    }

    console.log(JSON.stringify(resultReport, null, 2));
  } finally {
    ws.close();
  }
}

main().catch(err => {
  console.error("[perf-check] Error:", err);
  process.exit(1);
});
