// Kal Performance Before vs After Automated Summary Generator
// Outputs human-readable prose & lists (NO markdown tables as requested).

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultDataDir = path.resolve(__dirname, "../docs/perf-data");

function parseArgs() {
  const args = process.argv.slice(2);
  let dataDir = defaultDataDir;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--data-dir" && args[i + 1]) dataDir = path.resolve(args[++i]);
  }
  return { dataDir };
}

async function readJsonSafe(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  const { dataDir } = parseArgs();
  console.log("=== Kal Before vs After 性能比对自动摘要 ===");
  console.log("数据目录:", dataDir);

  const scales = ["small", "medium", "large"];
  for (const sc of scales) {
    const debugBefore = await readJsonSafe(path.join(dataDir, `debug-before-${sc}.json`));
    const debugAfter = await readJsonSafe(path.join(dataDir, `debug-after-${sc}.json`));
    const releaseBefore = await readJsonSafe(path.join(dataDir, `release-before-${sc}.json`));
    const releaseAfter = await readJsonSafe(path.join(dataDir, `release-after-${sc}.json`));

    console.log(`\n【规模档位：${sc.toUpperCase()}】`);

    if (!debugBefore) {
      console.log("- 缺失 BEFORE 数据，无法执行比对。");
      continue;
    }

    // 1. Debug IPC comparison
    console.log("1. Debug 命令时延与渲染数据读取 (WebView2 IPC)：");
    console.log(`- month_events (2026-10)：BEFORE 中位数 ${debugBefore.metrics.monthEvents.median} ms (p95 ${debugBefore.metrics.monthEvents.p95} ms)` +
      (debugAfter ? ` -> AFTER 中位数 ${debugAfter.metrics.monthEvents.median} ms (p95 ${debugAfter.metrics.monthEvents.p95} ms)` : " (待测 AFTER)"));

    console.log(`- day_events (2026-10-15)：BEFORE 中位数 ${debugBefore.metrics.dayEvents.median} ms (p95 ${debugBefore.metrics.dayEvents.p95} ms)` +
      (debugAfter ? ` -> AFTER 中位数 ${debugAfter.metrics.dayEvents.median} ms (p95 ${debugAfter.metrics.dayEvents.p95} ms)` : " (待测 AFTER)"));

    const legacyBefore = debugBefore.metrics.legacy3MonthLoad || debugBefore.metrics.renderAmplification;
    console.log(`- 42格月历视图数据拉取：BEFORE 采用 3 个月全量并发 (全表扫描 3 次)，中位数 ${legacyBefore.median} ms (p95 ${legacyBefore.p95} ms)`);
    
    if (debugAfter?.metrics?.rangeEvents) {
      const range = debugAfter.metrics.rangeEvents;
      const speedup = (legacyBefore.median / range.median).toFixed(1);
      console.log(`  * AFTER 新增 range_events (${range.intervalStart} ~ ${range.intervalEnd})：单次合并归一化，中位数 ${range.median} ms (p95 ${range.p95} ms)。`);
      console.log(`  * 优化效益：单次视图数据准备加速约 ${speedup}x，彻底消除 3 倍全表扫描放大。`);
      if (debugAfter.metrics.rangeEquivalence?.verified) {
        console.log(`  * 语义等价性断言：已核验通过。range_events 返回的 ${range.itemsReturned} 个事项 ID 与旧 3 个月结果过滤至 42 格区间的集合完全精确一致。`);
      }
    } else if (debugAfter) {
      const legacyAfter = debugAfter.metrics.legacy3MonthLoad || debugAfter.metrics.renderAmplification;
      console.log(`  * AFTER 仍运行 3 个月旧接口：中位数 ${legacyAfter.median} ms (p95 ${legacyAfter.p95} ms)`);
    }

    // 2. Search comparison
    console.log("2. 全日期搜索 (各 20 次)：");
    for (const [qname, qdata] of Object.entries(debugBefore.metrics.searchEvents)) {
      const afterQ = debugAfter?.metrics?.searchEvents?.[qname];
      const afterText = afterQ ? ` -> AFTER 中位数 ${afterQ.median} ms (p95 ${afterQ.p95} ms)` : "";
      console.log(`- 关键词 '${qdata.query}'：BEFORE 中位数 ${qdata.median} ms (p95 ${qdata.p95} ms)${afterText}`);
    }

    // 3. Release process tree comparison
    console.log("3. Release 生产二进制资源与启动代理：");
    if (releaseBefore) {
      const smB = releaseBefore.SteadyMemory;
      console.log(`- BEFORE 稳定状态：Kal 主进程私有提交 ${smB.MainProcess.PrivateBytesMB} MB (RSS ${smB.MainProcess.WorkingSetMB} MB)；进程树 7 进程私有提交总和 ${smB.TotalPrivateBytesMB} MB (工作集总和 ${smB.TotalWorkingSetMB} MB，含共享页重复)。`);
      console.log(`- BEFORE 首次 HWND 创建代理：${releaseBefore.FirstWindowCreationProxyMs} ms (仅代表 Win32 句柄创建，未确认类名，不代表 UI 渲染或冷启动完成)。`);
    }
    if (releaseAfter) {
      const smA = releaseAfter.SteadyMemory;
      console.log(`- AFTER 稳定状态：Kal 主进程私有提交 ${smA.MainProcess.PrivateBytesMB} MB (RSS ${smA.MainProcess.WorkingSetMB} MB)；进程树 7 进程私有提交总和 ${smA.TotalPrivateBytesMB} MB (工作集总和 ${smA.TotalWorkingSetMB} MB，含共享页重复)。`);
      console.log(`- AFTER 首次 HWND 创建代理：${releaseAfter.FirstWindowCreationProxyMs} ms (口径保持一致，仅供同机基线参考)。`);
    }
  }
}

main().catch(err => {
  console.error("比对失败:", err);
  process.exit(1);
});
