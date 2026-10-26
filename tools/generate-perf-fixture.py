#!/usr/bin/env python3
"""
Generate deterministic performance fixtures for Kal.
Generates small (20), medium (2,000), large (20,000) normalized items.
Maintains exact date, empty line, markdown strikethrough, note, and search semantics.
"""

import os
import shutil
import sqlite3
import random
from collections import defaultdict
from datetime import date, timedelta

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DB = os.path.join(BASE_DIR, "_fixture", "calendar.db")
OUT_DIR = os.path.join(BASE_DIR, "_fixture", "perf-20261015")

def count_normalized(db_path):
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    # 1. events
    events = cur.execute("SELECT ev_date, ev_start_date FROM event_table").fetchall()
    ev_count = 0
    for d, s in events:
        if (s and len(s) >= 8) or (d and len(d) >= 8):
            ev_count += 1
            
    # 2. items
    items = cur.execute("SELECT it_content FROM item_table").fetchall()
    it_count = 0
    for (content,) in items:
        if content:
            for line in content.split('\n'):
                if line.strip():
                    it_count += 1
                    
    # 3. notes
    notes = cur.execute("SELECT nt_cdate FROM note_table").fetchall()
    nt_count = 0
    for (cdate,) in notes:
        if cdate and len(cdate) >= 8:
            nt_count += 1
            
    conn.close()
    return ev_count + it_count + nt_count, ev_count, it_count, nt_count

SAMPLE_TASKS = [
    "项目进度对齐与里程碑检查",
    "周会对齐与行动项跟进",
    "发布验证及冒烟测试",
    "需求评审与交互原型核对",
    "系统架构与数据流审查",
    "性能压测与基线对比分析",
    "Bug修复与错误日志排查",
    "代码重构与类型声明补充",
    "客户沟通与反馈整理",
    "开发文档与接口规范编写",
    "Sprint Planning 与任务拆解",
    "Standup Sync 与阻塞排查",
    "Design Review 细节推敲",
    "Release 准备与制品核验",
    "数据库索引与查询计划分析",
    "网络通信与重连策略验证",
    "内存占用与泄漏排查",
    "自动化测试流水线调优",
    "桌面端窗口焦点与交互适配",
    "壁纸取色引擎算法核查"
]

SPECIAL_TASKS = [
    "全日期快速检索与拼音首字母测试",
    "WorkerW探针多屏兼容性验收",
    "架构评审：双模式嵌入生命周期闭环",
    "离线农历二十四节气换算核验",
    "私有字体与字宽拉伸渲染比对"
]

SAMPLE_NOTES = [
    ("技术架构选型记录", "Tauri v2 + WebView2 双模式嵌入，保留原生性能同时杜绝重量级依赖。"),
    ("性能测试方案笔记", "针对 42 格日历与搜索进行多轮基线评测，严防读取放大与主线程阻塞。"),
    ("色彩空间算法备忘", "采用 OKLab 空间加权 k-means++ 聚类提取壁纸主色，WCAG 对比度保证 13:1。"),
    ("协议通道通信规范", "采用 Windows 命名管道与 OVERLAPPED 异步 I/O，8 秒硬超时拦截挂死。"),
    ("键盘热键与焦点调度", "Win+Alt+C 全局呼出临时置顶，失焦自动沉底桌面，保持系统低干扰。")
]

def generate_fixture(target_path, target_total, seed=42):
    random.seed(seed)
    if os.path.exists(target_path):
        os.remove(target_path)
    shutil.copyfile(SRC_DB, target_path)
    
    conn = sqlite3.connect(target_path)
    cur = conn.cursor()
    # clear existing sample data
    cur.execute("DELETE FROM item_table")
    cur.execute("DELETE FROM event_table")
    cur.execute("DELETE FROM note_table")
    
    # Target allocations
    target_notes = max(1, int(target_total * 0.025))
    target_events = max(1, int(target_total * 0.10))
    target_items = target_total - target_events - target_notes
    
    # 1. Generate notes
    for i in range(target_notes):
        title_base, content_base = SAMPLE_NOTES[i % len(SAMPLE_NOTES)]
        title = f"{title_base} #{i+1}"
        content = f"{content_base}\n序号: {i+1}\n备注: 性能基线测试固定样本"
        d = date(2026, 1, 1) + timedelta(days=i % 365)
        cdate = f"{d.strftime('%Y-%m-%d')} {9 + (i % 8):02d}:00:00"
        cur.execute(
            "INSERT INTO note_table (nt_id, u_id, pj_id, nt_unique_id, nt_title, nt_content, nt_cdate, nt_mdate) VALUES (?, 0, 1, ?, ?, ?, ?, ?)",
            (i + 1, f"perf_note_{i+1}", title, content, cdate, cdate)
        )
        
    # 2. Generate events
    base_date = date(2026, 1, 1)
    for i in range(target_events):
        d = base_date + timedelta(days=random.randint(0, 364))
        hour = random.randint(8, 20)
        minute = random.choice([0, 15, 30, 45])
        dt_str = f"{d.strftime('%Y-%m-%d')} {hour:02d}:{minute:02d}:00"
        content = random.choice(SAMPLE_TASKS)
        if i < len(SPECIAL_TASKS):
            content = SPECIAL_TASKS[i]
        status = 1 if random.random() < 0.25 else 0
        cur.execute(
            "INSERT INTO event_table (ev_id, u_id, pj_id, ev_unique_id, ev_date, ev_start_date, ev_content, ev_status) VALUES (?, 0, 1, ?, ?, ?, ?, ?)",
            (i + 1, f"perf_ev_{i+1}", dt_str, dt_str, content, status)
        )
        
    # 3. Generate item_table
    # Group tasks by date to respect UNIQUE INDEX on (u_id, pj_id, it_unique_id, u_mid, group_id)
    items_by_date = defaultdict(list)
    items_created = 0
    
    # Determine date span based on size
    span_days = 365 if target_total <= 2000 else 730
    
    while items_created < target_items:
        # 40% in Oct 2026, 30% in Sep/Nov 2026, 30% elsewhere
        r = random.random()
        if r < 0.40:
            d = date(2026, 10, 1) + timedelta(days=random.randint(0, 30))
        elif r < 0.70:
            d = date(2026, 9, 1) + timedelta(days=random.randint(0, 60))
        else:
            d = base_date + timedelta(days=random.randint(0, span_days - 1))
            
        uid = d.strftime("%Y%m%d")
        task = random.choice(SAMPLE_TASKS)
        if random.random() < 0.20:
            task = f"~~{task}~~"
        items_by_date[uid].append(task)
        items_created += 1
        
    # Insert grouped days into item_table
    row_id = 1
    for uid in sorted(items_by_date.keys()):
        tasks = items_by_date[uid]
        lines = []
        for t in tasks:
            lines.append(t)
            if random.random() < 0.15:
                lines.append("") # Preserve empty line semantics
        content = "\n".join(lines)
        cur.execute(
            "INSERT INTO item_table (it_id, u_id, pj_id, it_unique_id, it_content) VALUES (?, 0, 1, ?, ?)",
            (row_id, uid, content)
        )
        row_id += 1
        
    conn.commit()
    conn.close()
    
    total, ev, it, nt = count_normalized(target_path)
    print(f"Generated {os.path.basename(target_path)}: Total={total} (Events={ev}, Items={it}, Notes={nt})")
    assert total == target_total, f"Expected {target_total}, got {total}"

def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    small_path = os.path.join(OUT_DIR, "calendar-small.db")
    medium_path = os.path.join(OUT_DIR, "calendar-medium.db")
    large_path = os.path.join(OUT_DIR, "calendar-large.db")
    
    # Small: exact copy of source fixture (20 items)
    shutil.copyfile(SRC_DB, small_path)
    tot, ev, it, nt = count_normalized(small_path)
    print(f"Small fixture: Total={tot} (Events={ev}, Items={it}, Notes={nt})")
    
    # Medium: 2,000 items
    generate_fixture(medium_path, 2000, seed=42)
    
    # Large: 20,000 items
    generate_fixture(large_path, 20000, seed=42)
    
    print("All fixtures generated successfully in:", OUT_DIR)

if __name__ == "__main__":
    main()
