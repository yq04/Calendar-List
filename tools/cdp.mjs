// 通过 WebView2 的 CDP 调试端口直接查 DOM / 跑 JS
//
// 为什么要它：Tauri 把前端内嵌进二进制，改完必须重编译；而用截图判断
// 「改动有没有生效」既慢又容易被字形/半透明误导。CDP 能直接问页面真相。
//
// 用法：
//   1) 以调试端口启动外壳：
//        $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
//        .\target\debug\kal.exe
//   2) node tools/cdp.mjs "document.querySelectorAll('.kal-cell').length"
//      node tools/cdp.mjs --file expr.js
//
// Node 22+ 自带 WebSocket，无需任何依赖。

const PORT = process.env.KAL_CDP_PORT || "9222";

async function findTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  // 挑一个真正的页面目标（排除 devtools / worker）
  const page = list.find(t => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("没有找到页面目标：" + JSON.stringify(list.map(t => t.type)));
  return page;
}

function evaluate(wsUrl, expression, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error("CDP 超时")); }, timeoutMs);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression,
          returnByValue: true,
          awaitPromise: true,
          // 让结果可读：对象/数组直接序列化出来
          generatePreview: false,
        },
      }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== 1) return;
      clearTimeout(timer);
      ws.close();
      const r = msg.result;
      if (r?.exceptionDetails) {
        reject(new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
        return;
      }
      resolve(r?.result?.value);
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error("WebSocket 错误: " + (e.message || e))); };
  });
}

const args = process.argv.slice(2);
let expr;
if (args[0] === "--file") {
  const fs = await import("node:fs/promises");
  expr = await fs.readFile(args[1], "utf8");
} else if (args.length) {
  expr = args.join(" ");
} else {
  console.error("用法: node cdp.mjs <表达式>   或   node cdp.mjs --file <脚本>");
  process.exit(2);
}

try {
  const target = await findTarget();
  const value = await evaluate(target.webSocketDebuggerUrl, expr);
  if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
} catch (err) {
  console.error("CDP 失败:", err.message);
  process.exit(1);
}
