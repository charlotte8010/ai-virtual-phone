# Float Cognitive Memory Layer —— 工程实施设计文档

> 面向仓库：`charlotte8010/ai-virtual-phone`  
> 基准分支：`main`  
> 文档性质：工程实施版 / 可直接交给 Codex 拆分执行  
> 更新日期：2026-08-31

---

## 0. 文档目标

这份文档不是再次描述“想做什么”，而是回答：

1. **当前 Float 记忆系统到底是什么结构；**
2. **哪些地方必须改，哪些地方暂时不要碰；**
3. **Sully 式“思考方式”应该以什么顺序接入；**
4. **每个文件具体承担什么职责；**
5. **如何保证旧数据、旧角色、现有跨 App 记忆不被破坏；**
6. **如何做到失败可降级、改动可回滚、每个阶段可独立验收。**

最终目标不是复制 Sully，而是得到：

```text
Float Unified Life Timeline
            +
Atomic Long-term Memory
            +
Cognitive Retrieval Layer
            +
Future Intent
            +
Recall / Consolidation
            +
Memory Graph
```

也就是：

> Float 继续负责“角色经历了什么”，认知层负责“哪些经历会留下、什么时候想起来、会联想到什么、哪些记忆越来越牢”。

---

# 1. 当前实现审计

以下以当前 `main` 分支为基线。

## 1.1 `lib/memory-types.ts`

当前 `MemoryEntry` 的核心结构大致是：

```ts
interface MemoryEntry {
  id: string;
  characterId: string;
  sourceApp: string;

  type: "long_term" | "core";

  content: string;

  embedding?: number[];

  importance: number;

  createdAt: string;
  updatedAt: string;

  sourceMessageIds?: string[];
  metadata?: Record<string, unknown>;
}
```

目前没有第一类字段：

```text
tags
mood
kind
accessCount
lastAccessedAt
stability
futureIntent
cognitiveRoom
```

这意味着 Float 当前的长期记忆本质仍然接近：

> 一段文本 + 一个向量 + 一个 importance。

---

## 1.2 `lib/memory-summarizer.ts`

当前长期记忆流程可以抽象成：

```text
Native Timeline
    ↓
累计到约 80 个新事件
    ↓
Memory Summary API
    ↓
一段总结文本
    ↓
生成 1 条 long_term MemoryEntry
```

当前重要特征：

- 一批事件生成 **1 条长期摘要**；
- 自动生成长期记忆的 `importance` 固定为 `0.8`；
- Memory Summary API 已经是独立辅助 API；
- Embedding API 也是单独配置；
- embedding 失败并不等于必须放弃正文记忆。

### 核心问题

如果 80 个事件被压成一大段：

```text
A 发生了……
后来 B……
期间用户说……
角色又……
然后 C……
```

那么后续即使加入：

- BM25
- tags
- mood
- accessCount
- memory graph
- future intent

召回单位依然太粗。

所以认知层升级的第一性问题不是“评分器怎么写”，而是：

> **必须把长期记忆从“批量摘要块”改成“多个原子记忆”。**

---

## 1.3 `lib/memory-service.ts`

当前召回大致是：

```text
load all long_term
    ↓
如果全部能塞进 longTermTokenBudget
    ↓
全部返回

否则：
    ↓
有 embedding
→ vector similarity 排序

没有 embedding
→ newest-first
```

### 这里有一个非常关键的问题

只要 token budget 足够大：

> **召回算法实际上不会发生。**

也就是说，即使以后加入 `accessCount` / `importance` / `tags`，如果仍保留：

```ts
if (allMemoriesFitBudget) {
  return allMemories;
}
```

角色依然不是在“想起”，而是在“把数据库全文塞进脑子”。

因此 Cognitive Layer 必须改变一个基础原则：

> **即使所有长期记忆都放得下，也仍然执行候选生成、评分、去重和选择。**

Token budget 只是最终上限，不再是“要不要检索”的开关。

---

## 1.4 `lib/memory-storage.ts`

当前 IndexedDB：

```text
DB: ai_phone_memory_db_v1
version: 3

store:
  memories
```

现有索引：

```text
by_character
by_character_type
by_character_created
```

当前最大长期记忆默认约 500 条。

### 工程判断

在 500 条这个量级：

- Future Intent 扫描；
- 简单关键词检索；
- tag overlap；
- 本地 rank；

都可以先直接针对单角色集合执行。

**Phase 1 不需要为了性能立刻增加复杂索引。**

这可以避免过早升级 IndexedDB schema。

---

## 1.5 `lib/core-memory-builder.ts`

当前 Core Memory：

```text
若干 long_term
    ↓
Memory Summary API
    ↓
1 条 core memory
```

新 Core 默认：

```ts
importance: 0.95
```

Core 的目的本来是：

- 关系身份；
- 稳定长期事实；
- 重大共同经历；
- 角色长期自我认知。

因此升级后必须明确：

> **Future Intent 默认不应成为 Core。**

例如：

```text
“明天下午一起吃饭”
```

即使 importance 很高，它仍然是有生命周期的计划，而不是永久人格事实。

---

# 2. 总体工程决策

## 2.1 不重写各 App

以下现有入口继续保留：

```text
chat
group_chat
moments
xiaohongshu
diary
checkphone
story
vn
game
custom_app
...
```

它们继续汇入现有 Native Timeline。

本次改造主要发生在：

```text
Timeline 之后
Prompt 注入之前
```

---

## 2.2 把系统拆成四层

```text
┌─────────────────────────────┐
│ 1. Native Event Layer       │
│ Float 已有，全 App 生活史    │
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐
│ 2. Memory Extraction Layer  │
│ 原子长期记忆 / Future Intent │
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐
│ 3. Memory Storage Layer     │
│ 文本 / tags / mood / stats  │
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐
│ 4. Cognitive Retrieval      │
│ vector/BM25/time/access/link │
└─────────────────────────────┘
```

---

## 2.3 生成与召回分离

禁止让一个函数同时负责：

```text
生成记忆
+
检索记忆
+
修改 accessCount
+
拼 Prompt
```

建议明确拆分：

```ts
extractMemories(...)
selectMemoriesForPrompt(...)
buildMemoryPrompt(...)
commitMemoryRecall(...)
```

这样后续调试时能知道：

- 是记忆没生成；
- 还是生成了但没被检索；
- 还是检索到了但被排名淘汰；
- 还是 Prompt 拼装出了问题。

---

# 3. Phase 1 数据模型

建议先只加 optional 字段，避免强制迁移旧记录。

```ts
export type MemoryKind =
  | "event"
  | "relationship"
  | "user_fact"
  | "self_fact"
  | "knowledge"
  | "future_intent";

export type MemoryMood =
  | "neutral"
  | "happy"
  | "tender"
  | "excited"
  | "sad"
  | "angry"
  | "anxious"
  | "afraid"
  | "jealous"
  | "embarrassed"
  | "lonely"
  | "nostalgic";

export type FutureIntentType =
  | "plan"
  | "promise"
  | "goal"
  | "wish"
  | "expectation";

export type FutureIntentStatus =
  | "pending"
  | "overdue"
  | "fulfilled"
  | "cancelled";

export type TimePrecision =
  | "exact"
  | "day"
  | "range"
  | "vague"
  | "unknown";

export interface FutureIntentMeta {
  type: FutureIntentType;

  status: FutureIntentStatus;

  /**
   * ISO timestamp.
   * 如果只有日期，也可以使用当天约定的标准边界值，
   * 但必须同时记录 timePrecision。
   */
  targetAt?: string;

  targetEndAt?: string;

  timezone?: string;

  timePrecision?: TimePrecision;

  /**
   * 保留模型解析前的原始表达：
   * "明晚" / "下个月" / "以后" / "生日的时候"
   */
  originalTimeExpression?: string;

  fulfilledAt?: string;
  cancelledAt?: string;

  /**
   * 改期时可使用。
   */
  replacedByMemoryId?: string;
}

export type CognitiveRoom =
  | "living_room"
  | "bedroom"
  | "study"
  | "user_room"
  | "self_room"
  | "attic"
  | "windowsill";

export interface MemoryEntry {
  id: string;
  characterId: string;
  sourceApp: string;

  type: "long_term" | "core";

  content: string;

  embedding?: number[];

  importance: number;

  createdAt: string;
  updatedAt: string;

  sourceMessageIds?: string[];

  // Cognitive Layer
  tags?: string[];
  mood?: MemoryMood;
  kind?: MemoryKind;

  accessCount?: number;
  lastAccessedAt?: string;

  stability?: number;

  futureIntent?: FutureIntentMeta;

  /**
   * Float 自身不必依赖房间运行。
   * 主要用于 Sully 迁移兼容和未来高级模式。
   */
  cognitiveRoom?: CognitiveRoom;

  metadata?: Record<string, unknown>;
}
```

---

# 4. 旧数据兼容策略

旧 MemoryEntry 读取时统一 normalize：

```ts
export function normalizeMemoryEntry(
  memory: MemoryEntry
): MemoryEntry {
  return {
    ...memory,

    tags: Array.isArray(memory.tags)
      ? memory.tags
      : [],

    kind: memory.kind ?? "event",

    accessCount:
      Number.isFinite(memory.accessCount)
        ? memory.accessCount
        : 0,

    stability:
      Number.isFinite(memory.stability)
        ? memory.stability
        : getInitialStability(memory),
  };
}
```

建议初始 stability：

```ts
function getInitialStability(
  memory: MemoryEntry
): number {
  if (memory.type === "core") return 0.95;

  return clamp(
    0.35 + memory.importance * 0.4,
    0,
    1
  );
}
```

### 原则

不要在应用启动时：

```text
遍历所有旧数据
→ 重写全部 IndexedDB
```

先采用：

> **read-time normalization**

只有该记忆后续真正被修改时，再以新格式写回。

---

# 5. 原子长期记忆重构

这是整个工程最重要的一步。

## 5.1 当前模式

```text
80 events
↓
1 summary
```

改成：

```text
80 events
↓
0～N atomic memories
```

建议：

```text
N 最大值：8
```

不是每 80 个事件必须生成 8 条。

如果整批没有值得长期保存的内容：

```json
{
  "memories": []
}
```

是合法结果。

---

## 5.2 新 Extraction Schema

建议新建：

`lib/memory-extraction.ts`

```ts
export interface ExtractedMemoryCandidate {
  content: string;

  tags: string[];

  importance: number;

  mood?: MemoryMood;

  kind: MemoryKind;

  futureIntent?: FutureIntentMeta;

  /**
   * 能映射时尽量保留事件引用。
   */
  sourceEventRefs?: string[];
}

export interface MemoryExtractionResult {
  memories: ExtractedMemoryCandidate[];
}
```

---

## 5.3 Memory Summary Prompt 要求

模型必须：

1. 只保存具有持续价值的信息；
2. 把互不相关的事件拆开；
3. 不虚构；
4. 保留：
   - 人名；
   - 地名；
   - 时间；
   - 数字；
   - 明确承诺；
   - 关系变化；
   - 用户稳定事实；
5. 每条生成 2～6 个短标签；
6. importance 由模型动态判断；
7. future intent 必须分类；
8. 最多 8 条；
9. 输出严格 JSON。

示例：

```json
{
  "memories": [
    {
      "content": "用户和宋瑾约好9月5日晚一起看电影。",
      "tags": ["宋瑾", "电影", "约定"],
      "importance": 0.86,
      "mood": "tender",
      "kind": "future_intent",
      "futureIntent": {
        "type": "plan",
        "status": "pending",
        "targetAt": "2026-09-05T20:00:00+08:00",
        "timePrecision": "exact",
        "originalTimeExpression": "9月5日晚"
      }
    },
    {
      "content": "用户说自己最近很喜欢某部作品。",
      "tags": ["用户偏好", "作品"],
      "importance": 0.68,
      "mood": "excited",
      "kind": "user_fact"
    }
  ]
}
```

---

# 6. Structured Output 校验

绝不能直接：

```ts
const parsed = JSON.parse(result.content);
await save(parsed);
```

需要 validator。

建议：

```ts
function sanitizeExtractedMemory(
  raw: unknown
): ExtractedMemoryCandidate | null
```

至少处理：

### 6.1 importance

```ts
importance = clamp(
  Number(raw.importance) || 0.5,
  0,
  1
);
```

---

### 6.2 tags

```text
最多 6 个
每个 trim
空字符串删除
重复删除
单个标签长度限制
```

例如：

```ts
tags = unique(raw.tags)
  .map(normalizeTag)
  .filter(Boolean)
  .slice(0, 6);
```

---

### 6.3 enum

任何未知：

```text
kind
mood
futureIntent.type
futureIntent.status
timePrecision
```

都不能原样进入数据库。

---

### 6.4 Future Intent 一致性

如果：

```ts
kind !== "future_intent"
```

则：

```ts
futureIntent = undefined;
```

反过来，如果：

```ts
kind === "future_intent"
```

但模型没有提供 `futureIntent`：

可以 fallback：

```ts
futureIntent = {
  type: "expectation",
  status: "pending",
  timePrecision: "unknown",
};
```

---

# 7. Extraction Fallback

Memory Summary API 可能出现：

- JSON 前后夹解释；
- 截断；
- 非法 JSON；
- 枚举拼错；
- 部分字段缺失。

不能因此丢掉整批记忆。

建议三层降级：

```text
Strict JSON
   ↓ fail
提取 JSON code block / tolerant parse
   ↓ fail
旧式 plain-text summary
```

最终兜底：

```ts
{
  content: oldSummaryText,
  importance: 0.8,
  kind: "event",
  tags: [],
}
```

这样新系统挂掉时：

> 至少退回现在 Float 的能力，而不是完全没有长期记忆。

---

# 8. 每批为什么不能生成太多记忆

如果 80 events 直接让模型生成 30 条：

- DB 很快膨胀；
- embedding 成本增加；
- 重复严重；
- 每个微小聊天都变成“永久回忆”。

建议：

```text
0～8 条 / batch
```

并在 Prompt 中明确：

> 普通寒暄、即时状态、无后续意义的碎片不要保存。

---

# 9. 记忆去重

长期 extraction 入库前增加：

`lib/memory-dedupe.ts`

## 9.1 第一层：Exact / Normalized Hash

```text
去标点
统一空白
lowercase（适用语言）
```

相同内容直接跳过。

---

## 9.2 第二层：Source Signature

如果同一原始事件已经被即时 detector 处理：

```text
characterId
+
sourceApp
+
sourceEventId
```

应该识别为同源。

若某些 App 没有稳定 event ID：

```text
sourceApp
+
timestamp
+
contentHash
```

作为 fallback signature。

---

## 9.3 第三层：Semantic Duplicate

如果 embedding 可用：

```text
cosine > 0.92
```

再结合：

```text
kind 相同
+
时间接近
```

可视为重复候选。

不要只靠 cosine 自动删除，避免：

```text
第一次约会
第二次约会
```

这种相似但实际不同的记忆被误合并。

---

# 10. Future Intent Immediate Detector

## 10.1 为什么必须有

周期总结可能等到第 80 个事件。

但：

```text
“明早八点叫我”
```

不能等几十条消息之后才形成计划记忆。

所以 Future Intent 有一条独立快速通道。

---

## 10.2 流程

建议新建：

`lib/future-intent-detector.ts`

```text
Native Event
    ↓
本地 heuristic
    ↓
疑似 future intent？
    ├─ 否 → 结束
    └─ 是
         ↓
Memory Summary API
         ↓
严格结构化解析
         ↓
时间 normalize
         ↓
dedupe / merge
         ↓
save long_term future_intent
```

---

# 11. Future Intent 预检测

不应该每条聊天都调用模型。

第一层用本地关键词 / 时间表达式：

```text
今天晚上
明天
明晚
后天
这周
周五
周末
下周
月底
下个月
生日
纪念日
以后
到时候

记得
别忘了
约好
答应
说好了
一起去
一起看
计划
准备
想去
希望
想要
一定会
到时候陪
```

### 注意

只命中：

```text
“以后”
```

不代表一定值得创建 future intent。

Heuristic 只负责：

> “值得问模型一下吗？”

最终分类仍由结构化解析决定。

---

# 12. Future Intent 时间模型

必须保留两类信息：

```text
解析后的绝对时间
+
用户原始表达
```

例如：

```json
{
  "targetAt": "2026-09-05T20:00:00+08:00",
  "timezone": "Asia/Singapore",
  "timePrecision": "exact",
  "originalTimeExpression": "周六晚上八点"
}
```

但产品代码不能把某个固定时区硬编码到记忆逻辑。

建议 detector 接收：

```ts
interface MemoryTimeContext {
  now: Date;
  timezone?: string;
}
```

由 Float 已有的世界时间 / 用户时间 / 角色时间模块提供。

如果当前没有统一时间接口：

> 先创建一个薄适配器，不要让 future detector 到处直接 `new Date()`。

---

# 13. 模糊未来表达

例如：

```text
“以后想和你去北海道”
```

应该保存：

```json
{
  "type": "wish",
  "status": "pending",
  "timePrecision": "vague",
  "originalTimeExpression": "以后"
}
```

而不是制造一个假的 `targetAt`。

这样它属于：

> 长期未来期盼

但不会在某一天突然变成：

> “已逾期”。

---

# 14. Future Intent 生命周期

推荐状态机：

```text
                   ┌─────────────┐
                   │  pending    │
                   └──────┬──────┘
                          │
          ┌───────────────┼───────────────┐
          │               │               │
          ▼               ▼               ▼
      fulfilled        cancelled        overdue
          ▲                               │
          │                               │
          └──── 后续确认已经完成 ──────────┘
```

---

## 14.1 pending → overdue

只适用于：

```text
plan
promise
```

且：

```text
timePrecision = exact/day/range
```

如果计划时间已过，但没有证据证明完成：

```text
pending → overdue
```

---

## 14.2 禁止自动 fulfilled

绝不能：

```ts
if (targetAt < now) {
  status = "fulfilled";
}
```

时间过去只说明：

> 该确认结果了。

并不说明：

> 事情真的发生了。

---

## 14.3 reschedule

例如：

```text
“周五不行，改周六吧”
```

建议后续支持：

旧：

```json
{
  "status": "cancelled",
  "replacedByMemoryId": "new-id"
}
```

新：

```json
{
  "status": "pending",
  "targetAt": "..."
}
```

第一版也可以只更新同一条记忆，但长期看“旧计划发生过改期”本身也是关系历史，保留替代链更完整。

---

# 15. Future Intent 重复合并

即时 detector 与 80-event periodic extraction 很可能都看到：

```text
同一个约定
```

因此 future intent 必须有专门 dedupe。

候选判断：

```text
相同角色
+
kind=future_intent
+
type 接近
+
targetAt / 时间范围接近
+
tags / 内容高度相似
```

例如已有：

```text
周五一起看电影
```

后续：

```text
周五晚上八点一起看电影
```

优先：

> enrich / update 旧记录

而不是创建两个计划。

---

# 16. Cognitive Retrieval v1

建议新建：

`lib/memory-ranking.ts`

`memory-service.ts` 负责 orchestration，不要把所有公式堆在一个文件。

---

## 16.1 新总流程

```text
current context
      ↓
load long-term memories
      ↓
┌───────────────────────────┐
│ Candidate Generators      │
├───────────────────────────┤
│ Vector Top K              │
│ Keyword/BM25 Top K        │
│ Future Intent             │
│ Recent fallback           │
│ Later: Memory Links       │
└──────────────┬────────────┘
               ↓
        merge / dedupe
               ↓
        feature scoring
               ↓
        unified ranking
               ↓
        diversity control
               ↓
        token budget
               ↓
       selected memories
               ↓
        build prompt
               ↓
       commit recall stats
```

---

# 17. 关键改变：永远执行 Selection

旧逻辑：

```ts
if (allFitBudget) {
  return all;
}
```

应该删除或绕过。

新逻辑：

```ts
const candidates = await generateCandidates(...);

const ranked = rankMemoryCandidates(
  candidates,
  context
);

return selectWithinBudget(
  ranked,
  config.longTermTokenBudget
);
```

即使：

```text
500 条记忆全部都放得进上下文
```

也不意味着应该全放。

---

# 18. Candidate Generator A：Vector

继续使用现有 embedding。

建议：

```text
Top K = 20
```

如果 embedding API 没配置 / query embedding 失败：

```text
跳过 vector 通道
```

而不是让整次聊天失败。

---

# 19. Candidate Generator B：Keyword / BM25

Phase 1 可以先实现轻量 text score。

如果后续加入真正 BM25，建议新建：

`lib/memory-text-search.ts`

主要解决：

```text
人名
作品名
地点
称呼
商品名
纪念日
专有名词
```

例如：

```text
“宋瑾”
```

这种 query 应该能直接召回 tags/content 中有：

```text
宋瑾
```

的记忆。

---

# 20. Candidate Generator C：Future Intent

扫描：

```text
kind === future_intent
AND
status in [pending, overdue]
```

然后根据：

```text
targetAt
targetEndAt
timePrecision
type
```

计算 urgency。

建议初版：

```text
今天             1.00
明天             0.90
未来 2～3 天     0.75
未来 4～7 天     0.45
过去 0～1 天     0.80  overdue
过去 2～3 天     0.55  overdue
更久             0.20  overdue
模糊 wish/goal    不做日期 urgency
```

---

# 21. Candidate Generator D：Recent Fallback

为了避免：

```text
embedding 挂了
+
关键词没命中
```

导致长期记忆完全空白，

保留：

```text
最近 5～10 条有效长期记忆
```

作为 fallback candidate。

注意：

> recent candidate ≠ 一定注入。

它仍然进入最终评分。

---

# 22. Ranking Feature

建议统一成：

```ts
interface MemoryFeatures {
  semantic: number;
  keyword: number;
  tag: number;
  importance: number;
  recency: number;
  access: number;
  stability: number;
  mood: number;
  temporal: number;
}
```

所有项标准化到：

```text
0～1
```

---

# 23. Vector Score

Cosine 原始值可能落在：

```text
-1 ～ 1
```

实际 embedding 往往偏正。

不要未经处理直接和：

```text
importance 0～1
```

相加。

建议：

```ts
semantic = clamp(
  (cosine - MIN_USEFUL_SIMILARITY) /
  (1 - MIN_USEFUL_SIMILARITY),
  0,
  1
);
```

具体阈值需要 Debug 数据后调。

---

# 24. Keyword / BM25 Score

真正 BM25 分数没有天然 0～1。

建议：

```text
先在本次候选内部 normalize
```

例如：

```ts
normalized =
  rawScore / maxRawScore;
```

---

# 25. Tag Score

简单 v1：

```ts
tagScore =
  matchedTagCount /
  Math.max(1, queryTagCount);
```

也可以对：

```text
角色名 / 人名 / 地点
```

给予 entity tag 更高权重。

第一阶段先简单实现。

---

# 26. Recency Score

建议：

```ts
recency =
  Math.exp(-ageDays / decayDays);
```

参考 decayDays：

```text
event          30
relationship   180
user_fact      365
self_fact      365
knowledge      180
```

Future Intent 使用 temporal，不走普通 recency 主逻辑。

---

# 27. Access Strength

```ts
access =
  Math.log1p(accessCount) /
  Math.log1p(REFERENCE_ACCESS_COUNT);
```

最后 clamp 到 1。

例如：

```ts
REFERENCE_ACCESS_COUNT = 20;
```

这样：

```text
20 次以后继续增长
```

不会继续无限增加召回优势。

### 重要

AccessCount 是正反馈。

如果权重过高会形成：

```text
第一次偶然被召回
→ access +1
→ 更容易再次召回
→ access 更高
→ 永久霸榜
```

因此 access 权重必须低。

---

# 28. Stability

Stability 不建议一开始成为巨大直接加分项。

更适合影响：

```text
记忆衰减速度
+
同分时 tie-break
+
未来 consolidation
```

Phase 2 可先给轻微权重。

---

# 29. Mood Priming

当前对话可选计算一个粗情绪状态。

匹配时：

```text
+ small boost
```

例如：

```ts
mood = sameMood ? 1 : 0;
```

但总权重不宜超过：

```text
0.03 ～ 0.05
```

避免角色陷入：

> 一难过就不断翻旧伤。

---

# 30. 推荐 v1 Rank Formula

建议第一版：

```ts
score =
  semantic   * 0.38 +
  keyword    * 0.12 +
  tag        * 0.08 +
  importance * 0.14 +
  recency    * 0.08 +
  access     * 0.05 +
  stability  * 0.05 +
  mood       * 0.03 +
  temporal   * 0.07;
```

总计：

```text
1.00
```

### 但 Future Intent 不应只靠公式

例如：

```text
今天晚上明确答应陪用户去医院
```

即使 semantic 几乎为 0，也应该有：

```text
protected candidate
```

规则：

```text
今天 / 明天
+
type = plan / promise
+
status = pending / overdue
```

至少获得一定的最终名额保障。

---

# 31. Protected Candidate

建议：

```ts
interface RankedMemoryCandidate {
  memory: MemoryEntry;
  score: number;

  protectedReason?:
    | "due_today"
    | "due_tomorrow"
    | "critical_overdue";
}
```

Selection 时：

1. 先保留 protected；
2. 再用普通排名补剩余名额；
3. protected 仍受总 token hard limit。

---

# 32. Diversity Control

没有 diversity 的 ranker 容易出现：

```text
同一次约会的 7 条细节
```

把其它人生记忆全挤掉。

建议：

```text
同一 source batch / event cluster
最多 2～3 条
```

如果没有 cluster ID：

可以临时用：

```text
高 cosine
+
时间非常接近
+
tag 高度重合
```

做近似聚类。

---

# 33. 最终数量

建议不要只靠 token。

增加：

```ts
maxSelectedLongTermMemories?: number;
```

默认：

```text
8～12
```

例如：

```text
最多 10 条
AND
不超过 longTermTokenBudget
```

这样上下文更稳定，也更容易调试。

---

# 34. Prompt 结构

建议不要继续把所有记忆平铺成一坨。

生成：

```text
## 稳定核心记忆
...

## 当前相关记忆
- ...
- ...

## 近期计划与约定
- [今天] ...
- [明天] ...
- [已过期未确认] ...

## 自然联想到的经历
- ...
```

第一阶段没有 Memory Links 时：

```text
“自然联想到的经历”
```

可以不生成。

---

# 35. Prompt 不应该暴露内部数据库语言

角色 Prompt 中不要出现：

```text
memory id
cosine score
accessCount
BM25 score
数据库
检索
候选池
```

模型只需要知道：

> “这些是你当前自然记起的信息。”

Debug 信息单独记录。

---

# 36. AccessCount：定义必须非常严格

只有：

```text
最终进入真实角色生成 Prompt
```

才算一次 recall。

以下全部不能 +1：

```text
进入 vector topK
进入 keyword topK
最终 ranking candidate
Debug preview
记忆管理页面预览
测试工具调用
后台检查
```

---

# 37. Selection 与 Recall Commit 分离

推荐 API：

```ts
export interface MemorySelectionResult {
  selected: MemoryEntry[];

  futureIntents: MemoryEntry[];

  debug?: MemoryRetrievalDebug;
}

export async function selectMemoriesForPrompt(
  characterId: string,
  context: string,
  options: MemorySelectionOptions
): Promise<MemorySelectionResult>;
```

这是：

> pure-ish read operation

然后：

```ts
export async function commitMemoryRecall(
  characterId: string,
  memoryIds: string[],
  recalledAt: string
): Promise<void>;
```

真正构建完生成 Prompt 后才调用。

---

# 38. Recall Stats Batch Write

不要：

```text
选中 8 条
→ 8 次 IndexedDB transaction
```

建议：

```text
1 transaction
→ load 8
→ accessCount +1
→ lastAccessedAt = now
→ put 8
```

这样减少：

- I/O；
- race；
- partial update。

---

# 39. Stability v1

建议新增一个简单且可解释的规则。

创建时：

```ts
initialStability =
  clamp(
    0.3 + importance * 0.45,
    0.3,
    0.8
  );
```

每次真实 recall：

```ts
stability =
  Math.min(
    1,
    stability + getRecallStabilityBoost(accessCount)
  );
```

例如：

```ts
function getRecallStabilityBoost(
  accessCount: number
): number {
  if (accessCount <= 1) return 0.02;
  if (accessCount <= 3) return 0.03;
  if (accessCount <= 10) return 0.015;

  return 0.005;
}
```

避免无限线性增长。

---

# 40. 不要第一版直接做物理删除式“遗忘”

Sully 式衰减可以学习，但 Float 第一版更适合：

```text
降低召回概率
```

而不是：

```text
删除数据库记录
```

因为 Float 还有“生活史”价值。

长期没有召回的普通事件：

```text
recency 下降
```

但仍然保存在时间线上 / 记忆库里。

---

# 41. Core Memory 的修改要求

建议保留现有 Core pipeline，但增加过滤。

送给 Core Builder 之前：

```ts
const coreEligibleEntries =
  allLongTermEntries.filter(entry => {
    if (entry.kind === "future_intent") {
      return false;
    }

    return true;
  });
```

更完整的后续规则：

```text
future_intent pending   → 不进 Core
future_intent overdue   → 不进 Core
future_intent cancelled → 不进 Core

future_intent fulfilled
→ 先转化为发生过的 event / relationship memory
→ 再由普通 Core 逻辑判断
```

例如：

```text
“我们答应明天去看电影”
```

不是 Core。

但完成后生成：

```text
“二人第一次一起去看了某电影，并把这件事视为重要约会。”
```

这条 `relationship/event` 才有资格被 Core Builder 吸收。

---

# 42. Core Builder Prompt 约束

建议 Prompt 增加：

```text
不要把尚未发生的计划、临时安排、待确认约定写入稳定核心记忆。
只有已经发生并对关系/身份产生长期影响的事件才可以成为核心记忆。
```

---

# 43. Memory Summary API 分工

现有：

```text
memorySummaryApiConfigId
```

继续承担：

```text
Periodic atomic extraction
Future Intent parsing
Core summary
Later: causal/metaphor link classification
```

第一阶段：

> 不新增第四个 API 配置。

---

# 44. Embedding API 分工

现有：

```text
embeddingApiConfigId
```

继续独立承担：

```text
Long-term embeddings
Sully import re-embedding
Query embedding
```

如果 embedding 失败：

```text
记忆正文仍保存
```

并允许后续重新补 embedding。

---

# 45. 普通 Recall 不能调用 LLM

聊天每次回复时：

```text
memory retrieval
```

应该完全由：

```text
IndexedDB
vector
keyword
tags
time
local score
later graph
```

完成。

不能：

```text
每次聊天
→ 再叫一个模型帮忙选记忆
```

否则：

- 慢；
- 贵；
- 不稳定；
- Debug 很难。

---

# 46. 并发与幂等

最大风险：

```text
Immediate Future Detector
+
Periodic Memory Extraction
```

可能同时处理同一事件。

建议每个 memory extraction 来源保留：

```ts
metadata: {
  extractionVersion?: string;
  sourceEventSignatures?: string[];
  extractionMode?: "periodic" | "future_immediate" | "import";
}
```

Immediate detector 生成：

```text
source event signature
```

Periodic extraction 入库前检查：

```text
是否已有同 signature 的长期记忆
```

---

# 47. Embedding 异步失败

保存顺序推荐：

```text
1. validate memory
2. save text memory
3. try embedding
4. update embedding if success
```

而不是：

```text
embedding fail
→ 整条记忆不保存
```

否则 cheap embedding provider 暂时故障会导致“失忆”。

---

# 48. Feature Flags

为了可回滚，建议在 `MemoryConfig` 增加 optional：

```ts
cognitiveMemoryEnabled?: boolean;

atomicMemoryExtractionEnabled?: boolean;

futureIntentEnabled?: boolean;

hybridRecallEnabled?: boolean;

memoryStabilityEnabled?: boolean;

memoryLinksEnabled?: boolean;
```

默认策略可以是：

```text
老用户升级：
兼容旧逻辑或按稳定版本默认开启 Phase 1

开发阶段：
隐藏于普通 UI，仅 Debug / config 使用
```

---

# 49. Phase 1 不需要 IndexedDB Version Bump

只往现有对象增加 optional 字段：

```text
tags
mood
kind
futureIntent
accessCount
...
```

IndexedDB object store 可以直接保存。

因此：

> **只要不加新 store / index，就暂时不必从 version 3 升级。**

---

# 50. MemoryLink 阶段再升级 DB

Phase 3 若增加：

```text
memory_links
```

建议：

```text
DB version 3 → 4
```

Store：

```text
memory_links
```

索引：

```text
by_character
by_from_memory
by_to_memory
by_character_type
```

---

# 51. MemoryLink 数据模型

```ts
export type MemoryLinkType =
  | "temporal"
  | "emotion"
  | "person"
  | "topic"
  | "causal"
  | "metaphor";

export interface MemoryLink {
  id: string;

  characterId: string;

  fromMemoryId: string;
  toMemoryId: string;

  type: MemoryLinkType;

  strength: number;

  createdAt: string;
  updatedAt: string;
}
```

---

# 52. 自动 Link：先算法，后 LLM

优先本地生成：

```text
temporal
person
topic
emotion
```

只有：

```text
causal
metaphor
```

才考虑用 Memory Summary API。

这样成本小很多。

---

# 53. Link 限制

单条记忆：

```text
最多 5～10 条 active links
```

超出时：

```text
按 strength 截断
```

不要形成无限稠密图。

---

# 54. Spreading Activation

Phase 3：

```text
Top-ranked seed memories
       ↓
读取强 link
       ↓
加入少量 related candidates
       ↓
重新经过总 ranker
```

建议：

```text
seed：最多 4
每 seed：最多 2 neighbor
全局新增：最多 4
```

---

# 55. Link 不是强制召回

A 被召回：

```text
A → B
```

不代表 B 必须注入。

B 只是得到：

```text
linkActivationScore
```

再进入 final ranker。

否则容易出现：

> 一条记忆拖出半辈子。

---

# 56. Sully Importer —— 工程位置

后续新建：

`lib/sully-memory-importer.ts`

但真正编码前必须先检查：

> Sully 当前实际备份 / 导出 JSON schema。

不能凭文档猜导出结构。

---

# 57. Sully Memory Palace 导入映射

推荐：

```text
content
→ content

importance 1～10
→ importance / 10

tags
→ tags

mood
→ mood

accessCount
→ accessCount

room
→ cognitiveRoom

timestamp
→ createdAt / source timestamp

original ID
→ metadata.sullyOriginalId
```

---

# 58. Sully Import Metadata

```ts
interface SullyImportMetadata {
  importedFrom: "sully";

  importVersion: "sully-palace-v1";

  sullyOriginalId: string;

  sullyOriginalRoom?: string;

  sullyOriginalLinks?: unknown[];

  importedAt: string;
}
```

实际可塞入：

```ts
metadata
```

而不必另建 interface 入库。

---

# 59. Sully ID 冲突

不要直接：

```ts
id = sullyNode.id;
```

推荐：

```text
sully:<sourceCharacterId>:<originalId>
```

或者：

```text
新 UUID
+
metadata.sullyOriginalId
```

第二种更干净。

---

# 60. Sully Embedding

禁止直接混入 Float 向量空间。

即使两个系统都写：

```text
embedding
```

也可能：

- 模型不同；
- dimension 不同；
- provider 不同；
- normalization 不同。

导入流程：

```text
读取 Sully node
↓
保留文本
↓
忽略 Sully embedding
↓
保存 Float memory
↓
Float embeddingApiConfigId
↓
重新向量化
```

---

# 61. Sully Windowsill

不要：

```text
windowsill → 全部 plan
```

需要分类：

```text
明确时间约定
→ plan

明确答应用户
→ promise

长期目标
→ goal

想做但无日期
→ wish

对未来关系的期待
→ expectation
```

如果 Sully 原节点没有足够字段：

可以使用 Memory Summary API **只做分类**。

不要重新总结原内容。

---

# 62. Sully Legacy 与 Palace 去重

Sully 同时可能有：

```text
Memory Palace
Daily memories
Monthly summaries
```

推荐：

```text
Palace
→ primary imported recall memory

Daily / Monthly
→ archive / fallback source
```

不要三套一起全部作为 long_term。

否则同一件事会出现：

```text
原始 Palace 节点
+
当天 Daily summary
+
当月 Monthly summary
```

召回时重复三次。

---

# 63. Sully Import Report

导入结束必须给出报告：

```ts
interface SullyImportReport {
  palaceNodesFound: number;
  imported: number;
  duplicatesSkipped: number;
  embeddingsRebuilt: number;
  embeddingsFailed: number;

  futureIntentClassified: number;
  futureIntentUnresolved: number;

  legacyEntriesFound: number;
  legacyEntriesArchived: number;

  warnings: string[];
}
```

这样迁移失败时有迹可查。

---

# 64. Debug 数据结构

建议：

```ts
interface MemoryCandidateDebug {
  id: string;

  source: Array<
    | "vector"
    | "keyword"
    | "future"
    | "recent"
    | "link"
  >;

  semantic?: number;
  keyword?: number;
  tag?: number;
  importance?: number;
  recency?: number;
  access?: number;
  stability?: number;
  mood?: number;
  temporal?: number;

  finalScore: number;

  selected: boolean;

  rejectedReason?: string;
}
```

---

# 65. Debug 日志示例

```text
[MemoryRetrieval]

character = xxx
query = "你今天有什么安排？"

candidates:
- mem_101
  vector=0.61
  future=1.00
  final=0.78
  protected=due_today
  selected=true

- mem_205
  keyword=0.90
  importance=0.68
  final=0.55
  selected=true

- mem_301
  vector=0.81
  duplicateCluster=mem_299
  selected=false
```

---

# 66. 用户 UI 暂时不要先做

Phase 1 完成前不建议先改：

```text
记忆宫殿页面
标签页面
漂亮卡片
关系图
```

先确认底层：

```text
生成对
召回对
时间对
状态对
统计对
```

再做 UI。

---

# 67. 未来 Memory UI

底层稳定后可以展示：

```text
和用户约好9月5日晚一起看电影

类型：未来计划
状态：待完成
时间：09/05 20:00

[宋瑾] [电影] [约定]

重要度：0.86
稳定度：0.71
真实召回：5 次
最后召回：09/04 23:11
```

---

# 68. 文件级修改清单

## `lib/memory-types.ts`

### 必改

新增：

```text
MemoryKind
MemoryMood
FutureIntentType
FutureIntentStatus
TimePrecision
FutureIntentMeta
CognitiveRoom
MemoryEntry optional cognitive fields
MemoryConfig feature flags
```

### 验收

- 旧 MemoryEntry TypeScript 不报错；
- 旧数据没有新增字段也能读取；
- 不要求 DB migration。

---

## `lib/memory-summarizer.ts`

### 必改

把：

```text
一批事件 → 一条文本 summary
```

改为：

```text
一批事件 → 0～N structured atomic memories
```

增加：

```text
structured parser
validator
fallback
dedupe
per-memory embedding
```

### 不建议

不要让该文件继续无限膨胀。

解析逻辑抽到：

`lib/memory-extraction.ts`

去重抽到：

`lib/memory-dedupe.ts`

---

## `lib/memory-service.ts`

### 必改

移除：

```text
all memories fit → return all
```

改为：

```text
candidate generation
→ rank
→ diversity
→ budget
→ result
```

### 建议抽出

`lib/memory-ranking.ts`

`lib/memory-text-search.ts`

---

## `lib/memory-storage.ts`

### 必改

增加：

```ts
batchUpdateMemoryRecallStats(...)
updateMemoryEntry(...)
findPotentialDuplicateMemories(...)
```

或等价 helper。

### Phase 1

不必改 DB version。

### Phase 3

MemoryLink 再升级 DB。

---

## `lib/core-memory-builder.ts`

### 必改

- 排除 active Future Intent；
- Core prompt 加入“未发生计划不得成为稳定核心”；
- fulfilled plan 应先转成普通 event/relationship memory 再考虑 Core。

---

## 新建 `lib/memory-extraction.ts`

职责：

```text
structured output types
parse
validate
sanitize
fallback
```

---

## 新建 `lib/memory-dedupe.ts`

职责：

```text
normalized content
source signature
semantic duplicate
future intent merge detection
```

---

## 新建 `lib/future-intent-detector.ts`

职责：

```text
local heuristic
cheap API classification
time normalization
dedupe/upsert
```

---

## 新建 `lib/memory-ranking.ts`

职责：

```text
feature calculation
normalization
final score
protected candidates
diversity
```

---

## 新建 `lib/memory-text-search.ts`

职责：

```text
keyword
BM25 later
tag overlap
```

---

## Phase 3 新建 `lib/memory-links.ts`

职责：

```text
MemoryLink CRUD
auto links
link pruning
spreading activation
```

---

## 后期新建 `lib/sully-memory-importer.ts`

职责：

```text
parse Sully export
map Palace nodes
preserve metadata
dedupe legacy
re-embed
migration report
```

---

# 69. 建议 Commit 顺序

不要让 Codex 一次完成整个系统。

---

## Commit 1 — Types & Compatibility

修改：

```text
memory-types.ts
compat helpers
```

新增字段，但不改变运行行为。

### 验收

- build 通过；
- 旧数据读取通过；
- 现有聊天行为完全不变。

---

## Commit 2 — Atomic Extraction

修改：

```text
memory-summarizer.ts
memory-extraction.ts
memory-dedupe.ts
```

### 验收

80 events 可以得到：

```text
0～N atomic memories
```

而不是固定 1 条。

必须验证：

- JSON 正常；
- JSON 非法 fallback；
- embedding fail 不丢正文；
- importance 不再固定 0.8；
- tags 正常；
- kind 正常。

---

## Commit 3 — Future Intent Immediate Path

新增：

```text
future-intent-detector.ts
```

接入 Native Event 后的合适位置。

### 验收

输入：

```text
“明晚八点一起看电影”
```

不需要等 80 events。

立刻出现：

```text
future_intent
pending
targetAt...
```

---

## Commit 4 — Cognitive Retrieval v1

修改：

```text
memory-service.ts
memory-ranking.ts
memory-text-search.ts
```

### 验收

即使 500 条长期记忆全部能塞入 token budget：

> 也只选择最相关的有限集合。

并验证：

```text
向量失败 → keyword/recent fallback 正常
专有名词 → keyword 可召回
今天计划 → future channel 可召回
```

---

## Commit 5 — Recall Stats & Stability

修改：

```text
memory-storage.ts
memory-service caller
```

### 验收

只有真正注入生成 Prompt 的记忆：

```text
accessCount +1
lastAccessedAt 更新
```

Debug preview 不增加。

---

## Commit 6 — Core Memory Guardrails

修改：

```text
core-memory-builder.ts
core prompt
```

### 验收

```text
明天看电影
```

不会进入 Core。

完成后的重要共同经历可以进入正常 Core 候选。

---

## Commit 7 — Debug Instrumentation

增加：

```text
retrieval reason
candidate score
selected/rejected reason
```

### 验收

出现异常召回时能回答：

> “为什么它想起了这条？”

---

## Commit 8 — Sully Importer

先确认 Sully 实际 export schema，再写。

### 验收

- 节点数量核对；
- tags 保留；
- mood 保留；
- accessCount 保留；
- room 保留；
- importance 转换；
- old embedding 不混用；
- 新 embedding 可重建；
- Legacy 不造成重复。

---

## Commit 9 — Memory Links

增加 Memory Graph。

### 验收

A 被召回后可带出相关 B，

但：

```text
B 必须仍经过总 ranker
```

且 link expansion 不爆炸。

---

# 70. 自动化测试矩阵

## 数据兼容

- [ ] 旧 `MemoryEntry` 无 tags 可以读
- [ ] 无 kind 默认 event
- [ ] 无 accessCount 默认 0
- [ ] 无 stability 可计算默认值
- [ ] 旧 Core 正常工作

---

## Structured Extraction

- [ ] 一个 batch 输出 0 条
- [ ] 一个 batch 输出 1 条
- [ ] 一个 batch 输出多条
- [ ] 超过 8 条会截断/拒绝
- [ ] importance clamp
- [ ] tags 去重
- [ ] 未知 enum fallback
- [ ] JSON 非法有 fallback
- [ ] API 截断不写入半截 JSON

---

## Future Intent

- [ ] “明晚八点”解析为 exact
- [ ] “明天”解析为 day
- [ ] “下周末”解析为 range/vague
- [ ] “以后想去日本”不制造假日期
- [ ] target 过期只变 overdue
- [ ] 不自动 fulfilled
- [ ] explicit cancel → cancelled
- [ ] reschedule 不产生无意义双 pending
- [ ] immediate 与 periodic 不重复

---

## Retrieval

- [ ] all-fit budget 仍执行 rank
- [ ] vector 正常
- [ ] vector API 缺失仍能召回
- [ ] keyword 能找专有名词
- [ ] tags 可加分
- [ ] 高 importance 有优势但不霸榜
- [ ] 高频 access 有优势但不霸榜
- [ ] due today future intent 有保障
- [ ] diversity 能压重复事件
- [ ] selected 数量受 maxCount 控制
- [ ] selected 总 token 受 budget 控制

---

## Recall Stats

- [ ] candidate 不 +1
- [ ] final selected +1
- [ ] prompt preview 不 +1
- [ ] Debug 不 +1
- [ ] 一轮批量更新
- [ ] lastAccessedAt 正确
- [ ] 并发写入不丢计数

---

## Cross-App

至少测试：

```text
chat → later xiaohongshu recall
moments → later chat recall
xiaohongshu → later chat recall
diary → later chat recall
checkphone → later chat recall
story → later chat recall
```

确保 Cognitive Layer 没有把 Float 原来的跨 App 优势弄丢。

---

# 71. 手工体验测试

技术单测通过后，还要做角色体验测试。

## Case A：普通旧事

Day 1：

```text
用户说自己买了一个杯子。
```

Day 10：

```text
“我那个杯子呢？”
```

预期：

- 能召回；
- 不需要原句完全相似；
- 不把其它十条购物记忆一起倒出来。

---

## Case B：Future Intent

Day 1：

```text
“周三晚上我们一起看电影。”
```

周三：

```text
“你干嘛呢？”
```

预期：

角色自然知道今晚有约。

不是机械说：

```text
“根据我的记忆数据库，我们有一个 Future Intent。”
```

---

## Case C：Overdue

原计划：

```text
昨晚打游戏
```

今天没有执行证据。

预期：

角色可以表现为：

```text
“昨晚不是说好……后来是不是没打成？”
```

而不是假设已经完成。

---

## Case D：高频回忆

某件事被自然提到很多次。

预期：

- accessCount 上升；
- stability 上升；
- 后续更容易想起；
- 但换一个毫无关系的话题时不应莫名冒出。

---

# 72. 性能预算

当前长期记忆上限约数百条时：

Phase 1 可以接受：

```text
单角色内存扫描
+
本地字符串匹配
+
排序
```

无需过早优化。

目标：

```text
普通 recall 不发额外 LLM request
```

网络调用只发生在：

```text
memory extraction
future intent classification
embedding
later complex link classification
```

---

# 73. 失败降级矩阵

| 故障 | 系统行为 |
|---|---|
| Memory Summary API 不可用 | 保留 Native Timeline，后续可重试 |
| Structured JSON 非法 | fallback 为旧式文本长期记忆 |
| Embedding API 不可用 | 保存文本记忆，vector 通道暂时跳过 |
| Query embedding 失败 | keyword + tags + future + recent |
| Future 时间解析失败 | 保存原表达，precision=unknown/vague |
| Recall stats 写失败 | 不阻塞角色回复 |
| Memory Link store 失败 | 回退为无 graph retrieval |
| Sully 单条 embedding 失败 | 记录报告，不丢导入正文 |

---

# 74. 明确“不做”的事情

第一阶段禁止：

1. **不要整套复制 Sully Memory Palace 代码。**
2. **不要把 7 个房间做成 Float 运行前提。**
3. **不要优先重做漂亮 UI。**
4. **不要把 Future Intent 塞进 Core。**
5. **不要把过期计划自动标记 fulfilled。**
6. **不要复用 Sully embedding。**
7. **不要 candidate 一出现就 accessCount +1。**
8. **不要让 accessCount 权重无限自增强。**
9. **不要每次聊天再调用 LLM 来挑记忆。**
10. **不要只改 retrieval，却继续把 80 events 压成唯一一条大摘要。**
11. **不要 Phase 1 就上 Attic Rumination。**
12. **不要 Phase 1 就建立复杂稠密 Memory Graph。**
13. **不要因为 embedding 失败就丢失记忆正文。**
14. **不要在没有真实 Sully export schema 前写死导入解析器。**

---

# 75. Phase 1 完成定义

满足以下条件，才算第一阶段真正完成：

```text
✓ 老数据兼容
✓ 多 App Timeline 不受影响
✓ 80-event batch 可生成原子记忆
✓ importance 动态生成
✓ tags 第一类保存
✓ kind 第一类保存
✓ Future Intent 可即时产生
✓ Future Intent 有时间生命周期
✓ all-fit 时仍进行认知筛选
✓ vector + keyword + time 混合召回
✓ 真正注入才增加 accessCount
✓ Stability 有基础巩固
✓ Core 不吞临时计划
✓ API 故障可降级
✓ Debug 能解释召回原因
```

---

# 76. Phase 2 完成定义

```text
✓ 真正 BM25
✓ 更稳定的 tag/entity extraction
✓ 更合理 recency decay
✓ stability 调参
✓ future intent fulfil/cancel 自动检测
✓ reschedule linking
✓ memory cluster / diversity 更准确
✓ Memory UI 展示认知字段
```

---

# 77. Phase 3 完成定义

```text
✓ MemoryLink Store
✓ temporal/person/topic/emotion links
✓ spreading activation
✓ link pruning
✓ Sully existing links migration
✓ graph debug view
```

---

# 78. Phase 4 可选高级认知

最后才评估：

```text
Room-specific weighting
Attic / unresolved memories
Rumination
Mood-dependent resurfacing
Advanced consolidation
Metaphor links
Self-model evolution
```

这些属于：

> “让角色的脑子更像某一种人”

而不是：

> “让角色先能正确记住事情”。

基础可靠性必须优先。

---

# 79. 推荐给 Codex 的执行方式

不要把整篇文档一次性丢给 Codex，然后说：

```text
“全部实现。”
```

推荐每次只给一个 commit 范围。

例如第一轮：

```text
请只实现 Commit 1：
Memory Types & Backward Compatibility。

要求：
- 不改变现有运行行为
- 不改 UI
- 不升级 IndexedDB version
- 新字段全部 optional
- 运行现有 typecheck/build
- 给出改动文件和兼容性说明
```

第二轮再做 Atomic Extraction。

这样每一步都有明确回滚点。

---

# 80. 最推荐的实际开发顺序

如果现在就开始动 Float，建议严格按：

```text
1. Types
   ↓
2. Atomic Extraction
   ↓
3. Future Intent Immediate Detector
   ↓
4. Always-on Cognitive Retrieval
   ↓
5. AccessCount + Stability
   ↓
6. Core Guardrails
   ↓
7. Debug
   ↓
8. Sully Import
   ↓
9. Memory Graph
   ↓
10. Advanced Sully cognition
```

这里最重要的前三个体验跃迁点是：

```text
Atomic Memory
Future Intent
Always-on Selection
```

因为它们分别解决：

```text
“记忆颗粒太粗”
“答应过的未来事情记不住”
“不是在想起，而是全塞进上下文”
```

---

# 81. 最终架构

```text
                       Float Apps
                           │
     ┌───────────┬─────────┼─────────┬────────────┐
     │           │         │         │            │
    Chat      Moments     XHS      Diary      CheckPhone ...
     │           │         │         │            │
     └───────────┴─────────┼─────────┴────────────┘
                           │
                           ▼
                 Unified Native Timeline
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
       Periodic Extraction      Immediate Future Intent
              │                         │
              └────────────┬────────────┘
                           ▼
                   Atomic Memory DB
                           │
             ┌─────────────┼──────────────┐
             │             │              │
          Vector        Keyword         Future
             │             │              │
             └─────────────┼──────────────┘
                           ▼
                    Cognitive Ranker
                           │
                  ┌────────┴────────┐
                  │                 │
               Relevant         Protected
               Memories      Plans/Promises
                  │                 │
                  └────────┬────────┘
                           ▼
                    Diversity / Budget
                           │
                           ▼
                      Prompt Memory
                           │
                           ▼
                    Character Reply
                           │
                           ▼
                   Recall Stats Commit
                           │
                           ▼
              AccessCount / Stability
                           │
                     Phase 3:
                    Memory Graph
```

---

# 82. 一句话工程结论

这次改造的关键不是：

> “给 Float 加几个 Sully 字段。”

而是把 Float 从：

```text
统一事件流
→ 大段长期摘要
→ 能塞多少塞多少
```

改成：

```text
统一事件流
→ 原子长期记忆
→ 多通道候选生成
→ 类认知式筛选
→ 真正被想起才巩固
→ 未来约定按时间进入意识
→ 后续通过 Memory Graph 形成联想
```

这条路线既保留 Float 原有的跨 App 生活史优势，也能逐步吸收 Sully 最有价值的“思考方式”，而不需要先把整个系统重写成记忆宫殿。
