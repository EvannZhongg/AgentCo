# AgentCo — Organization Runtime Kernel

第一阶段实现一个本地、Task-centric 的组织运行时。Manager 与 AgentRunner 未来都是它的客户端；任务、归属、通信、产物和执行状态由 Runtime 统一维护。

当前没有 LLM、智能拆解、AgentAsset、Capability、Tool Agent、Memory、Asset Lifecycle、Plugin、Workflow 或 GUI。

## 运行

要求 Node.js >= 22.16。开发与测试使用 Node.js 22.21.0、npm 11.19.1。

```sh
npm ci
npm run check
npm run demo
```

- `check`：严格 TypeScript 检查、编译、Node 内置测试运行器执行全部测试。
- `demo`：直接通过代码执行双 Agent 协作，打印按序事件与最终 `completed` 状态。
- 默认示例数据位于 `.agentco/example/`。可用 `npm run demo -- F:/AgentCo/.agentco/my-run` 指定目录；重复运行会在同一 Workspace 下创建新的 Run。

本阶段没有第三方运行时依赖，使用 `node:sqlite`。Node 22.21.0 会输出 SQLite 实验性 API 警告；项目保留该提示。版本锁定见 `package-lock.json`。

## 代码边界

```text
packages/
  runtime/
    runtime.ts          唯一公开 facade 的装配
    context.ts          SQL 事务 + EventStore + 提交后通知
    queries.ts          从关系表读取实体和投影
    run/                Workspace、Run、Run 结束规则
    task/               状态机、依赖 DAG、依赖传播
    agent/              临时 AgentInstance 生命周期
    events/             typed EventBus 与持久化 EventStore
    messaging/          短消息与 Artifact 引用
    artifacts/          产物创建、元数据、内容读取
  persistence/
    sqlite/             唯一 Schema、SQLite 连接与事务
    files/              Artifact 文件写入及完整性校验
  shared/               带类型 ID、实体、事件、错误、输入校验
examples/               可执行验收流程
tests/                  集成、故障注入与架构边界测试
```

这是一个 npm 包中的逻辑模块划分，没有额外的包发布或依赖注入框架。依赖方向是 `runtime → persistence → shared`，`runtime` 也可直接使用 `shared`。底层模块不依赖 Runtime；模块导入图无环。

仅包根入口 `@agentco/runtime-kernel` 可导入，SQL、Repository、事件发布器及内部 Service 不作为公共 API 导出。返回实体是读取快照，修改它们不会写回数据库。

## 使用统一 API

```ts
import { OrganizationRuntime } from "@agentco/runtime-kernel";

const runtime = new OrganizationRuntime({ dataDirectory: ".agentco/data" });
try {
  const workspace = runtime.workspace.create({ name: "Personal" });
  const run = runtime.run.create({ workspaceId: workspace.id, name: "Research" });
  const agent = runtime.agent.spawn({ runId: run.id, name: "A", role: "researcher" });
  const task = runtime.task.create({
    runId: run.id,
    title: "Produce report",
    input: { subject: "Organization Kernel" },
    expectedOutput: "A Markdown artifact",
  });
  const actor = { runId: run.id, taskId: task.id, agentId: agent.id };
  runtime.task.assign(actor);
  runtime.task.start(actor);
  const artifact = runtime.artifact.create({
    runId: run.id, taskId: task.id, producerAgentId: agent.id,
    name: "report.md", mediaType: "text/markdown", content: "# Report\nResult",
  });
  runtime.task.complete({ ...actor, outputArtifactIds: [artifact.id] });
} finally {
  runtime.close();
}
```

完整的 A → Artifact → B → feedback → Run 完成流程见 `examples/organization-run.ts`。

| API | 职责 |
| --- | --- |
| `workspace.create/get/list` | 一个数据目录内的逻辑 Workspace |
| `run.create/get/list/cancel` | 组织执行边界与显式取消 |
| `task.create/get/list` | 任务输入、输出要求、状态和归属 |
| `task.assign/start/complete/fail/cancel` | 正式任务操作 |
| `task.block/unblock` | 执行过程中的显式暂停与恢复 |
| `task.addDependency/removeDependency` | 尚未开始的任务依赖维护 |
| `agent.spawn/get/list/terminate` | 临时执行者及其投影状态 |
| `message.send/get/list` | 短消息、任务作用域、Artifact 引用 |
| `artifact.create/get/list/resolve` | 元数据、内容及同 Run 读取 |
| `events.subscribe(type 或 "*", listener)` | 当前实例提交后事件；返回取消订阅函数 |
| `events.list(runId, afterSequence?, limit?)` | 持久化历史，按 sequence 分页 |
| `graph.tasks/agents/communications` | 只读实体关系投影 |

写操作接收对象参数。读取单个 Run 内实体使用 `get(runId, entityId)`，集合读取使用 `list(runId)`。`message.list` 可带 `recipientId`，`artifact.list` 可带 `taskId`。ID 是有品牌的字符串类型，由创建操作返回。

## 状态规则

Task 的等待状态由依赖关系确定：

| 状态 | 含义及出口 |
| --- | --- |
| `pending` | 依赖尚未全部完成；依赖变化后转 `ready` 或 `blocked` |
| `ready` | 所有依赖均完成；有负责人后可 `start` |
| `running` | 已显式开始；可 `complete`、`fail`、`block`、`cancel` |
| `blocked` | 手动暂停，或直接/传递依赖被阻塞、失败、取消 |
| `completed` / `failed` / `cancelled` | 不可再变更的终态 |

没有依赖的任务在创建事务内从 `pending` 进入 `ready`。依赖失败或取消不会偷偷取消后续任务；后续任务保留为 `blocked`，由客户端决定取消或修改尚未开始的依赖。手动 block 必须显式 unblock，恢复后仍需 start。

依赖边禁止重复、自依赖、循环和跨 Run。任务一旦开始过，即使暂停，也不能改依赖。完成和失败要求当前任务为 `running`，调用者提供的 Agent 必须是负责人。完成时列出的输出 Artifact 必须属于该任务。

一个 Agent 可负责多个未完成任务，但同时只能执行一个任务。`currentTaskId`、`assignedTaskIds`、`idle/busy` 全部来自 Task 查询，Agent 表不存第二份任务队列或忙闲状态。Agent 的身份、角色、Run 和终止时间保存在 Agent 表。终止 Agent 前须处理其未完成任务。

交接通过 Task API：运行中的任务先 `block`，再 `assign` 给新 Agent，然后 `unblock/start`。一条写着“已交接”的 Message 不会改变归属。

Run 创建后为 `active`；空 Run 不自动完成。至少一个任务且全部进入终态时，按 `failed > cancelled > completed` 自动确定结果，并释放尚未终止的 Agent，保留其历史记录。显式 `run.cancel` 在同一事务内取消全部未完成任务、终止 Agent、结束 Run。终态 Run 不可新增工作或发送消息，仍可读取历史和 Artifact。

因为最后一个任务结束后 Run 会关闭，客户端应在结束当前最后一个任务前创建已知后续任务。当前阶段没有另设计划封板或重开机制。

## 唯一事实来源与一致性

SQLite 中包含 `workspaces`、`runs`、`tasks`、`task_dependencies`、`agent_instances`、`messages`、`message_artifacts`、`artifacts`、`task_artifacts`、`events`。

- 所有命令通过同一个事务入口执行；实体修改、依赖传播、Run 收敛和 EventStore 追加在同一事务内提交或回滚。
- SQLite 使用外键、跨 Run 复合外键、状态 CHECK、单 Agent 单运行任务唯一索引。数据库检查是同一路径的不变量约束，不是另一套业务状态。
- EventStore 是追加式审计日志，不用于重建另一份执行状态。事件有全局递增 `sequence`，排序不依赖时间戳。
- EventBus 在提交后按顺序调用监听者。监听者触发的新命令，其事件排在当前批次之后；同步异常与异步拒绝报告到 `onListenerError`，不会使已提交命令失败。异步回调的完成顺序不作保证。
- TaskGraph 来自任务和依赖边；AgentGraph 来自 Agent 和任务归属；CommunicationGraph 仅投影实际 Message。当前不建权限边，也不把通信记录解释成未来通信许可。
- Message 最多 4096 UTF-8 字节，类型仅有 `request_info/response/feedback/review_request/notification`。Task input 和 Artifact metadata 最多各 8192 字节 JSON；大内容使用 Artifact。

## 文件、事件交付与恢复边界

```text
dataDirectory/
  runtime.sqlite
  runtime.sqlite-wal / runtime.sqlite-shm   运行期间可能存在
  artifacts/<run-id>/<artifact-id>.bin
```

Artifact 文件名由 Runtime 生成，显示名称不会用于拼接路径。创建时先写同目录临时文件并 flush，再 rename，随后提交元数据与事件；SQL 提交失败时清理已写文件。读取校验字节长度和 SHA-256，缺失或损坏会显式报错。

文件系统与 SQLite 不是同一原子事务。若进程在文件 rename 后、数据库提交前被强制终止，可能留下未被引用的文件；它不会成为可查询 Artifact。本阶段不自动扫描或删除这种孤儿文件，也不声称提供跨文件系统的断电原子性。备份须保留 SQLite 和 Artifact 文件；进行简单文件复制前先关闭 Runtime。

EventBus 是单个 Runtime 实例内的即时通知，不提供持久化投递确认。进程可能在提交后、通知前退出；客户端重连应保存自己的 sequence 游标，通过 `events.list` 补读。历史读取不会重新广播事件。

重启直接读取已提交事实：`running` 仍为 `running`，不会凭空重试或启动 Agent。未来 AgentRunner 决定继续、暂停或失败处理。当前执行模型是一个本地 Runtime 所有者；不提供多进程事件广播、分布式调度或身份认证。API 的 Agent ID 校验提供作用域与归属约束，不是安全凭证。

当前内容接口用 string / Uint8Array / Buffer，读取在内存中完成，尚无流式大文件 API。Schema 仅有正式 v1；未知版本明确拒绝打开，没有旧 Schema 路由或 fallback。

## 验证

测试直接调用公共 Runtime API，不依赖 LLM：

- 双 Agent 完整协作，Artifact 引用，Message 不变更任务，Run 自动完成。
- 依赖扇入、循环拒绝、跨 Run 引用、非法转换、手动阻塞与正式交接。
- 失败和取消的传递、Run 结束与 Agent 释放。
- 精确事件顺序、嵌套命令事件排队、监听者错误隔离、提交前失败无通知。
- EventStore 故障注入，验证任务、依赖、Agent、Run 的原子回滚。
- Artifact 文件故障、元数据回滚后的文件清理、内容损坏及丢失。
- 关闭重开后的历史和进行中任务；数据库外键与完整性检查。
- 代码依赖方向、无循环依赖、唯一公共入口与无重复 Graph/Agent 状态表。

故障注入测试会直接访问自己的临时 SQLite 文件；这是测试手段，示例和运行时客户端只使用 facade。
