// 写入状态、能力位、乐观并发快照与待确认契约纯函数模块

import { isValidDateKey, isValidTimeStr } from "./calendar.js";

/**
 * 过滤并遮蔽任何潜在凭证/内部技术实现词，只向用户展示实用提示。
 */
export function sanitizeUserMessage(raw, fallback = "操作未完成，请稍后重试") {
  if (raw === null || raw === undefined) return fallback;
  let text = String(raw).trim();
  if (!text) return fallback;

  // 遮蔽 Bearer / token / key 等敏感片段与长哈希串
  text = text
    .replace(/Bearer\s+[A-Za-z0-9._\-~+/=]+/gi, "Bearer ***")
    .replace(/(sys_aimcp_token|confirm_token|aimcp_token|token|secret|password|apikey|api_key)\s*([:=])\s*\S+/gi, "$1$2***")
    .replace(/\b[A-Fa-f0-9]{28,}\b/g, "***")
    .replace(/\b[A-Za-z0-9_-]{36,}\b/g, "***");

  // 常见内部技术文案转为面向用户的实用中文说明
  if (/MCP.*未连接|连接.*MCP.*失败|无法连接.*MCP|ECONNREFUSED|connect.*failed/i.test(text)) {
    return "当前无法保存修改（日历主程序未开启写入服务）";
  }
  if (/readonly|只读|read-only|KAL_DB_PATH/i.test(text) && !/已保存/.test(text)) {
    return "当前日历处于只读模式，仅支持浏览与搜索";
  }
  if (/expired|stale|snapshot|快照|已变更|已被修改|不匹配/i.test(text)) {
    return "该安排刚刚已发生变化，请刷新后再试";
  }
  if (/DesktopCal\s*MCP\s*已(连接|响应)/i.test(text)) {
    return "可直接添加或修改安排";
  }
  if (/浏览器演示模式/.test(text)) {
    return "演示模式：修改仅保存在当前会话";
  }
  // 去除暴露底层实现的字样
  text = text.replace(/\b(DesktopCal\s*MCP|AIMCP|MCP|SQLite|rusqlite|IPC|Tauri)\b\s*/gi, "").trim();
  return text || fallback;
}

/**
 * 归一化 writeStatus() 返回结构：
 * 新契约：{ available: bool, canCreate: bool, canCreateEvent: bool, label: string }
 * 兼容旧版字符串或异常情况。
 */
export function normalizeWriteStatus(raw) {
  if (raw && typeof raw === "object") {
    const available = Boolean(raw.available);
    const canCreate = typeof raw.canCreate === "boolean" ? raw.canCreate : available;
    const canCreateEvent = typeof raw.canCreateEvent === "boolean" ? raw.canCreateEvent : available;
    const rawLabel = String(raw.label ?? "").trim();
    let hint = "";
    if (!available || (!canCreate && !canCreateEvent)) {
      hint = sanitizeUserMessage(rawLabel, "当前仅可浏览与搜索，暂不可保存修改");
    } else if (!canCreateEvent && canCreate) {
      hint = "当前仅支持添加无具体时间的任务";
    } else if (!canCreate && canCreateEvent) {
      hint = "当前仅支持添加带时间点的日程";
    } else if (/演示/.test(rawLabel)) {
      hint = "演示模式：修改仅保存在当前会话";
    }
    return {
      available: available && (canCreate || canCreateEvent),
      canCreate: available && canCreate,
      canCreateEvent: available && canCreateEvent,
      label: sanitizeUserMessage(rawLabel, available ? "可保存修改" : "当前不可保存修改"),
      hint,
    };
  }
  if (typeof raw === "string" && raw.trim()) {
    const isDemo = /演示/.test(raw);
    return {
      available: true,
      canCreate: true,
      canCreateEvent: true,
      label: sanitizeUserMessage(raw, "可保存修改"),
      hint: isDemo ? "演示模式：修改仅保存在当前会话" : "",
    };
  }
  return {
    available: false,
    canCreate: false,
    canCreateEvent: false,
    label: "当前仅可浏览与搜索，暂不可保存修改",
    hint: "当前仅可浏览与搜索，暂不可保存修改",
  };
}

/**
 * 计算单条 DayItem 的可操作能力：
 * - 若显式为 false，禁用相应入口；
 * - 缺失时兼容 Mock（note 默认全部 false，其余默认可编辑/删除；canComplete 若未显式给出，note 为 false，其余兼容 true）。
 * - 若全局 writeStatus.available === false，全部写入口禁用。
 */
export function getItemCapabilities(item, writeStatus = { available: true }) {
  if (!item || typeof item !== "object" || item.kind === "note") {
    return { canEdit: false, canDelete: false, canComplete: false };
  }
  if (writeStatus && writeStatus.available === false) {
    return { canEdit: false, canDelete: false, canComplete: false };
  }
  const canEdit = typeof item.canEdit === "boolean" ? item.canEdit : true;
  const canDelete = typeof item.canDelete === "boolean" ? item.canDelete : true;
  const canComplete = typeof item.canComplete === "boolean" ? item.canComplete : true;
  return { canEdit, canDelete, canComplete };
}

/**
 * 构造传给后端 item_update / item_toggle_done / item_delete 的完整 expected 快照
 * 完整保留 DayItem 全部字段（含 calendarId / remoteId / revision 及能力布尔位），供 Rust PartialEq 核对。
 */
export function buildExpectedSnapshot(item) {
  if (!item || typeof item !== "object") return null;
  const caps = getItemCapabilities(item, { available: true });
  return {
    id: String(item.id ?? ""),
    date: String(item.date ?? ""),
    time: String(item.time ?? ""),
    title: String(item.title ?? ""),
    done: Boolean(item.done),
    kind: String(item.kind ?? "item"),
    canEdit: typeof item.canEdit === "boolean" ? item.canEdit : caps.canEdit,
    canDelete: typeof item.canDelete === "boolean" ? item.canDelete : caps.canDelete,
    canComplete: typeof item.canComplete === "boolean" ? item.canComplete : caps.canComplete,
    calendarId: String(item.calendarId ?? ""),
    remoteId: String(item.remoteId ?? ""),
    revision: String(item.revision ?? ""),
  };
}

/**
 * 核对当前事项与 expected 快照是否一致（供 Mock 与测试验证过期快照）
 * 包含 calendarId / remoteId / revision（缺省按空串比对）。
 */
export function matchesExpectedSnapshot(current, expected) {
  if (!expected) return true;
  if (!current || typeof current !== "object") return false;
  return (
    String(current.id ?? "") === String(expected.id ?? "") &&
    String(current.date ?? "") === String(expected.date ?? "") &&
    String(current.time ?? "") === String(expected.time ?? "") &&
    String(current.title ?? "") === String(expected.title ?? "") &&
    Boolean(current.done) === Boolean(expected.done) &&
    String(current.kind ?? "") === String(expected.kind ?? "") &&
    String(current.calendarId ?? "") === String(expected.calendarId ?? "") &&
    String(current.remoteId ?? "") === String(expected.remoteId ?? "") &&
    String(current.revision ?? "") === String(expected.revision ?? "")
  );
}

/**
 * 校验 CRUD 参数（date / title / time）
 */
export function validateCrudInput({ date, title, time, checkTitle = true, checkTime = false } = {}) {
  if (date !== undefined && !isValidDateKey(date)) {
    throw new Error("日期格式无效（应为 YYYY-MM-DD）");
  }
  if (checkTitle) {
    if (typeof title !== "string") throw new Error("内容不能为空");
    if (title.includes("\r") || title.includes("\n")) {
      throw new Error("内容必须是一行文字");
    }
    const trimmed = title.trim();
    if (!trimmed) throw new Error("内容不能为空");
  }
  if (checkTime && time !== undefined && time !== "") {
    if (!isValidTimeStr(time)) {
      throw new Error("时间格式无效（应为 HH:MM）");
    }
  }
}

/**
 * 将后端可能返回的 문자열 或结构化 summary 对象转为面向用户的简明中文说明
 */
function formatPendingSummary(summary, fallback = "该修改需要确认后才会保存") {
  if (!summary) return fallback;
  if (typeof summary === "string") {
    return sanitizeUserMessage(summary, fallback);
  }
  if (typeof summary === "object") {
    const text =
      summary.summary ||
      summary.message ||
      summary.description ||
      summary.title ||
      summary.text ||
      "";
    if (typeof text === "string" && text.trim()) {
      return sanitizeUserMessage(text, fallback);
    }
  }
  return fallback;
}

/**
 * 解释写接口返回值：
 * - { status: 'pending_confirmation', pendingId, summary, message } -> 需用户点击确认（缺 pendingId 时绝不锁死 UI，也绝不误判为 saved）
 * - { status: 'cancelled' } -> 已取消
 * - { status: 'saved' } 或 null/undefined -> 已保存
 * - 其他未知 { status: '...' } -> 绝不默认当 saved，返回非 saved 状态并提示用户
 */
export function interpretWriteResult(result) {
  if (result === null || result === undefined) {
    return {
      outcome: "saved",
      pendingId: "",
      message: "已保存",
    };
  }
  if (result && typeof result === "object") {
    if (result.status === "saved") {
      return {
        outcome: "saved",
        pendingId: "",
        message: "已保存",
      };
    }
    if (result.status === "pending_confirmation") {
      const pendingId = String(result.pendingId ?? "").trim();
      if (!pendingId) {
        return {
          outcome: "cancelled",
          invalid: true,
          reason: "missing_pending_id",
          pendingId: "",
          message: "待确认响应缺少有效标识，未保存修改",
        };
      }
      return {
        outcome: "pending_confirmation",
        pendingId,
        message: formatPendingSummary(
          result.summary ?? result.message,
          "该修改需要确认后才会保存",
        ),
      };
    }
    if (result.status === "cancelled") {
      return {
        outcome: "cancelled",
        pendingId: "",
        message: sanitizeUserMessage(result.message || "已取消修改", "已取消修改"),
      };
    }
    return {
      outcome: "cancelled",
      invalid: true,
      reason: "unknown_status",
      pendingId: "",
      message: sanitizeUserMessage(
        result.message || result.summary || "未识别的保存状态，请刷新后核对",
        "未识别的保存状态，请刷新后核对",
      ),
    };
  }
  return {
    outcome: "cancelled",
    invalid: true,
    reason: "invalid_result",
    pendingId: "",
    message: "未识别的保存结果，请刷新后核对",
  };
}

/**
 * 异步渲染序号守卫：防止慢请求晚返回覆盖最新月份/日期视图
 */
export function createSeqGuard() {
  let seq = 0;
  return {
    next() {
      seq += 1;
      return seq;
    },
    isCurrent(token) {
      return token === seq;
    },
    current() {
      return seq;
    },
  };
}
