## 项目背景与定位

本项目希望构建一个运行于个人电脑的 **动态 Agent Organization**。

用户只需要向 Manager 描述目标。Manager 根据任务动态创建或复用不同角色的 Agent，建立任务依赖和通信关系。各 Agent 拥有独立上下文和职责，但能够在授权范围内直接沟通、请求信息、交接任务和互相 Review，而不是所有信息都必须经过 Manager 中转。

Agent 根据自身任务动态装配 Tool、Skill 和 Workflow。当现有能力不足时，可以向专门的 Tool Agent 请求能力建设，由其复用、组合、接入或创建新的 Tool。

任务完成后，系统不会简单保存所有临时 Agent，而是根据实际使用情况评估 Agent、Tool、Skill 和 Workflow，将有长期价值的能力沉淀为资产，并逐渐合并或淘汰低价值、重复和过时资产。

因此，系统长期增长的不是 Agent 数量，而是：

> **组织任务的能力、Agent 之间协作的经验，以及可复用的能力资产。**

最终希望形成一个随着用户长期使用不断适应其工作方式的个人 AI 组织。

# 核心设计

整体可以收敛成下面几个层次：

```text id="6w3j1n"
                    User
                     │
                     ▼
                  Manager
                     │
          ┌──────────┼──────────┐
          │          │          │
       TaskGraph   AgentGraph   CommunicationGraph
          │          │          │
          └──────────┼──────────┘
                     ▼
                Agent Runtime
           ┌─────────┼─────────┐
           ▼         ▼         ▼
        Agent A   Agent B   Agent C
           ↕         ↕         ↕
              Message Bus
                   │
             Artifact Store
                   │
            Capability Layer
                   │
        ┌──────────┼──────────┐
        ▼          ▼          ▼
      Tools      Skills    Workflows
        │
     Missing?
        ▼
     Tool Agent
        │
        ▼
      Providers
   OS / MCP / API / Browser

───────────────────────────────────

        Memory + Asset System

 Agent / Tool / Skill / Workflow
        ↓
 Lifecycle Evaluation
        ↓
 Retain / Promote / Merge / Retire
```

## 1. Manager：组织者，而不是超级 Agent

Manager 的核心职责是维护整个组织：

```
目标理解
    ↓
任务拆解
    ↓
角色组织
    ↓
建立协作关系
    ↓
观察执行状态
    ↓
动态调整组织
    ↓
判断任务完成
```

它不需要自己完成所有工作，也不应该成为所有 Agent 通信的中转站。Manager 主要维护三张图：**TaskGraph** 描述“什么工作依赖什么工作”；**AgentGraph** 描述“谁负责什么”；**CommunicationGraph** 描述“谁可以和谁直接协作”。

---

## 2. Agent：动态员工

AgentAsset 是长期可复用的员工模板。

AgentInstance 是当前任务中的实际员工。

Manager 首先尝试复用已有 AgentAsset，不合适时再动态创建新的角色。任务结束后 Instance 被释放。

只有真正反复有价值的角色才进入长期资产库。避免Agent无限增长。

> 实现状态：目前只有 AgentInstance（`agent_instances` 表）；AgentAsset、角色复用与受控的 `role` 标识尚未实现，Instance 上还没有资产挂点。

---

## 3. Agent 之间允许真正协作

Agent 需要的能力，以及它们各自的落地形式：

```
request_info        → Message（已实现）
feedback            → Message（已实现）
request_review      → Message（已实现，类型名为 review_request）
report              → Artifact（正式产物走 Artifact，不占用短消息）
delegate / handoff  → Task 操作（已实现：block → assign → unblock/start）
```

已实现的 Message 类型共 5 种：`request_info`、`response`、`feedback`、`review_request`、`notification`，单条不超过 4096 UTF-8 字节。

**delegate / handoff 不是 Message 类型。** 归属变更只能通过 Task API 完成；一条写着“已交接”的消息不会改变任务归属。

但不是完全自由群聊。

通信具有：

```
Task Scope           ✅ 已实现（Message 绑定 taskId）
Message Type         ✅ 已实现（5 种受控枚举）
Permission           ⬜ 未实现
Communication Graph  ⬜ 未实现（当前只投影已发生的 Message，不表达任何未来通信许可）
```

这样既允许真实协作，又避免 Multi-Agent 无限聊天。

> 接入 Manager 之前，不要假设通信已经受权限约束：目前任何两个存活的 Agent 都可以互发消息。

---

# 4. 运行时通信机制建议明确区分：

**Task** 表示“需要谁做什么”；**Message** 表示 Agent 之间的短信息交流；**Artifact** 是报告、代码、文档、分析结果等大型正式产物；**Event** 表示 task completed、tool ready、agent failed 等系统状态变化。

因此 Agent 之间不会通过复制完整 Context 来协作。

---

# 5. Capability / Asset Layer

Agent 不固定绑定 Tool。它根据任务判断：

> 我需要什么能力？

然后向 Capability Layer 请求，Agent 不需要关心底层实现。

---

# 6. Tool Agent：公司的能力建设者

当 Agent 找不到所需能力：

```
Capability Missing
       ↓
    Tool Agent
```

Tool Agent 按：

```
Reuse
 ↓
Compose
 ↓
Integrate
 ↓
Create
```

处理。

新 Tool 先作为临时能力参与当前任务，经过验证后才可能成为长期资产。

这样 Agent 可以随着任务获得新能力，但不会让每个 Agent 自己随意生成和执行任意代码。

---

# 7. Asset System：长期积累的核心

系统真正长期存在的是：

```
Agent
Tool
Skill
Workflow
```

这些统一视为 Asset。

生命周期可以简单定义：

```
Candidate
   ↓
Trial
   ↓
Active
   ↓
Mature
   ↓
Deprecated
   ↓
Retired
```

系统根据真实任务表现决定：

```text id="9atxoh"
保留
晋升
合并
替代
淘汰
```

例如多个高度相似的 Research Agent 最终可能合并成一个稳定的 Researcher Asset。

---

# 8. Memory：服务组织长期演化

记忆可以保持四层：

```text id="h9c2t4"
Working Memory
→ 当前 Agent / Task

Episodic Memory
→ 过去做过什么

Semantic Memory
→ 用户、项目、事实、决策

Asset Memory
→ 哪些 Agent / Tool 在什么任务上表现好
```

尤其是 Asset Memory，它连接：

```text id="9t9zxm"
过去任务
    ↓
经验
    ↓
未来 Manager 组织决策
```

Manager 下次遇到类似任务，可以知道：

> 过去这种任务使用 A+B 的组织效果很好。

长期甚至可以从“资产复用”继续演进到 **组织模式复用**。

---

# 9. 推荐技术架构

仍然比较适合：

```
Desktop
Tauri + React/Vue

        ↓

Core Runtime
TypeScript

        ↓

Manager / Agent Runtime
TaskGraph
Message Bus
Event Bus
Capability Broker
Memory
Asset System

        ↓

Providers

├─ Native OS / Rust
├─ MCP
├─ Browser
├─ HTTP API
├─ Plugin
└─ Python Worker
```

数据：
需要查询、关联、去重、更新状态、统计生命周期的数据进 SQLite；偏配置、可读可编辑、追加日志、体积较大的内容用 JSON/JSONL/文件。

每次架构迁移完成后必须收敛到唯一正式执行路径。新职责边界尚未完成时可以暂时存在迁移适配层；一旦新路径验证稳定，应同步删除旧实现、重复状态、旧 Schema、Fallback 路由及无明确需求的兼容代码。不得为了“可能以后有用”长期保留 Legacy Path。