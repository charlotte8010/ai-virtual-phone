# Float Cognitive Memory — 分支与上游同步策略

> 适用工程文档：`docs/float-cognitive-memory-engineering-plan.md`
> 
> 功能开发分支：`feature/cognitive-memory`
> 
> 上游同步基线：`main`

---

## 1. 分支职责

后续不要继续把 Cognitive Memory 的大规模改造直接堆在 `main`。

```text
原作者 upstream/main
        │
        ▼
charlotte8010/ai-virtual-phone:main
        │
        ▼
feature/cognitive-memory
```

### `main`

主要职责：

- 接收并整理原作者后续更新；
- 尽量保持接近 upstream；
- 验证 upstream 更新在当前 fork 中能否正常构建和运行；
- 不再直接承载大规模 Cognitive Memory 开发。

### `feature/cognitive-memory`

主要职责：

- 承载 Cognitive Memory Layer 的全部开发；
- 原子长期记忆；
- Future Intent；
- Hybrid Retrieval；
- AccessCount / Stability；
- Sully Memory Import；
- Memory Graph；
- 后续高级认知机制。

---

## 2. 原作者更新后的同步顺序

当原作者仓库有新更新时，推荐流程：

```text
1. 获取 upstream/main 最新版本
2. 将 upstream 更新同步进本 fork 的 main
3. 确认 main 能正常 build / run
4. 再把 main 合并或 rebase 到 feature/cognitive-memory
5. 只处理真正发生代码重叠的位置
```

不要反过来先把 upstream 直接硬合到功能分支，然后再整理 `main`。

`main` 应始终作为较干净的上游同步基线。

---

## 3. 降低 Merge Conflict 的工程原则

Cognitive Memory 开发优先采用：

> **新增独立模块 + 对原文件做小范围接线。**

优先新增：

```text
lib/memory-extraction.ts
lib/memory-dedupe.ts
lib/future-intent-detector.ts
lib/memory-ranking.ts
lib/memory-text-search.ts
lib/memory-links.ts
lib/sully-memory-importer.ts
```

然后只在原作者已有文件中做必要接线，例如：

```text
lib/memory-types.ts
lib/memory-summarizer.ts
lib/memory-service.ts
lib/memory-storage.ts
lib/core-memory-builder.ts
```

不要把数百、数千行 Cognitive Memory 新逻辑直接堆进这些原文件。

这样做的目的：

1. 降低和 upstream 同一代码区域发生冲突的概率；
2. 原作者以后更新朋友圈、小红书、查手机、UI、剧情等模块时，可以更容易吸收；
3. Cognitive Memory 可以相对独立地测试、回滚和迁移；
4. 如果 upstream 以后重构记忆系统，可以只重新适配接线层，而不是重做整个功能。

---

## 4. 新增文件通常比修改原文件更安全

例如新增：

```text
docs/...
lib/memory-ranking.ts
lib/future-intent-detector.ts
```

通常不会阻碍未来同步 upstream。

真正容易产生冲突的是：

```text
我们和 upstream 同时修改同一个原文件的同一段代码。
```

因此“自定义改动很多”本身不是最大问题，**改动是否和 upstream 高度重叠**才是。

---

## 5. 上游也修改记忆系统时怎么办

如果未来 upstream 自己也大改：

```text
memory-service.ts
memory-summarizer.ts
memory-storage.ts
```

不要机械地保留本分支旧实现。

应先比较两边架构，再决定：

```text
A. 正常 merge
B. 局部 transplant Cognitive Layer
C. 重新基于新的 upstream 接口适配
```

目标不是让 `feature/cognitive-memory` 永远和 upstream 分叉。

目标是：

> **让自定义认知记忆层保持尽可能低耦合，从而持续吃到原作者的新功能。**

---

## 6. Codex 开发约束

以后让 Codex 修改 Cognitive Memory 时，应明确告诉它：

```text
当前工作分支必须是 feature/cognitive-memory。
不要把功能开发提交到 main。
尽量新增模块，不要无必要地重写 upstream 原文件。
对 upstream 文件只做最小接线。
每个阶段单独 commit，保证可回滚。
```

如果某个任务必须大改 upstream 原文件，Codex 应在改动前说明：

- 为什么不能通过独立模块实现；
- 哪些区域未来最可能与 upstream 产生冲突；
- 是否可以进一步降低耦合。

---

## 7. 当前约定

从建立 `feature/cognitive-memory` 开始：

```text
main
= 上游同步基线

feature/cognitive-memory
= Cognitive Memory 功能开发线
```

后续本文档所述的 Commit 1、Commit 2、Future Intent、Hybrid Retrieval、AccessCount、Sully Import、Memory Graph 等开发，原则上均在 `feature/cognitive-memory` 上进行。
