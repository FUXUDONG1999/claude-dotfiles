# 代码抽象与重构方法论 · 详细参考

> 核心信条：上游可变，内核稳定；变体可插拔，内核零改动；设计占四成，工程保障占六成。

---

## 1. 通用骨架

任何"多种变体 + 共性处理"的系统都可归约为三层结构：

```
变体侧（可变）            切分点（边界数据）          稳定内核（不变）
─────────────            ─────────────              ─────────────
策略接口 + 注册中心  ──►  边界数据结构  ──►  无状态单例 + open()→Session
（supportType 路由）      （变体产出、内核消费）      （处理 + 收尾）
```

- **变体侧**：N 个实现，各自 supportType() 自报类型，注册中心按类型路由。新增变体 = 加一个 @Component。
- **切分点**：变体与内核交接的那个数据结构。它是抽象的支点——找到它，就找到了切分线。
- **稳定内核**：无状态单例，open(ctx)→Session 会话模式承载单次执行状态，消费切分点数据，产出结果。

### 切分点发现法（详细步骤）

1. **列举变体 I/O**：列出所有变体的输入和输出格式。
2. **画数据流图**：找所有变体输出后、共享处理前的那个数据形态。
3. **找公共子集**：提取所有变体输出的公共部分。
4. **不够则加适配层**：如果各变体输出格式不统一，加一层适配（各变体输出 → 统一 DTO）。适配层的输出就是切分点。
5. **分歧裁决**：如果团队对切分点有分歧，用"新增变体测试"——假设加一个全新变体，按各自的切分点设计，看哪个改动面更小，小的胜出。

> 找不到一个明确的边界数据结构，就说明"变与不变"还没切干净——回去再找。

---

## 2. 六条核心设计原则

### 2.1 变与不变分离——找到"切分点"

- 变：变体各自不同的部分（上游）。
- 不变：所有变体共享的处理逻辑（下游内核）。
- 切分点：两者交接的数据结构。

### 2.2 策略模式 + 注册中心（开闭原则 + 依赖倒置）

为变体定义策略接口，用 supportType() + Registry 路由。新增一种变体 = 写一个 implements + @Component，注册逻辑与内核零改动。同时落地开闭原则与依赖倒置。

注册中心实现因语言/框架而异：
- Java/Spring：@Component + 构造器注入 List<Adapter>
- Python：entry_points 或装饰器注册到全局 dict
- Go：init() 函数注册到包级 map
- Rust：inventory crate 或 lazy_static

关键是"按类型路由 + 新增零改动"这个模式本身，不是 IoC 容器。

### 2.3 命名编码契约——用类型名防止误用

不要起模糊的名字，要让类型名自带约束：
- BoundedSourceReader：宣告"有界，hasNext() 必须终止"。
- StreamIngester：宣告"无界，长驻消费"。
- SyncNotifier vs AsyncNotifier：宣告同步/异步语义。

> 当一个名字能阻止下一个人误用，抽象就成功了。命名是最廉价的文档。

### 2.4 无状态单例 + 按执行会话（线程安全）

Spring Bean 是单例。若处理逻辑持有"当前批次/当前请求"等执行状态在实例字段上，并发执行会互相覆盖。解法：

```
XxxPipeline（无状态单例，线程安全）
    │  open(ctx)
    ▼
Session（有状态，状态隔离在调用方线程栈上）   ← 每次调用一个，互不干扰
    │  accept(item) / flush()
```

- 单例只持有无状态依赖（纯函数式组件、DAO 等）。
- 执行状态（累加器、计数器、当前批次）放 Session，由调用方持有，随调用方栈生灭——等价于局部变量，天然线程安全。

> 凡是单例 Bean 需要承载"单次调用状态"的，都用 open()→Session，不要把状态放实例字段。这是并发偶发 bug 的根治之法。

### 2.5 非对称即正确——不强行统一语义不同的东西

当变体在生命周期 / 错误处理 / 完成语义上本质不同时，让它们的抽象也不同，不要为了"整齐"强行套同一接口。

- 采集器：拉取/订阅需要 source 适配器（主动连源），推送不需要（数据在请求体，被动接收）。
- 通知：即时发送（同步）与定时批量（异步）生命周期不同，不必硬塞一个接口。

> 强行统一 = 把复杂性泄漏进每个实现。非对称不是缺陷，是诚实。

### 2.6 接口先行，实现延后

对尚不确定的变体，先定义抽象接口，不引入依赖、不写实现。具体实现等真正需要时再加，加的时候不动接口、不动内核。

> 空注册中心（注入空 List）在 Spring 下正常启动，是安全的——扩展点已就位，零运行时成本。

---

## 3. 多领域应用示例

同一骨架，不同填法：

### 通知发送

```
NotifyChannel（企微/邮件/短信/webhook）─策略+注册─► RenderedMessage ─► NotificationPipeline
                                                                         open→accept(消息)→flush
                                                                         （节流 + 发送 + 落库记录）
```

- 变体：各渠道 SDK 调用、签名、限频差异。
- 内核：节流评估、发送重试、发送记录落库——与渠道无关。
- 切分点：RenderedMessage（模板渲染后的统一消息体）。

### 支付

```
PaymentChannel（微信/支付宝/银行卡）─策略+注册─► PaymentOrder ─► PaymentPipeline
                                                                open→accept(订单)→flush
                                                                （风控 + 记账 + 对账入队）
```

- 变体：各支付渠道下单/回调协议。
- 内核：风控校验、记账、对账——与渠道无关。
- 非对称：即时支付 vs 代扣（异步回调）可独立抽象。

### 文件存储

```
StorageBackend（COS/OSS/本地）─策略+注册─► Blob ─► StoragePipeline
                                                  open→accept(分片)→flush
                                                  （分片 + 断点续传 + 校验）
```

### 数据导出

```
ExportFormat（CSV/Excel/JSON）─策略+注册─► DataSet ─► ExportPipeline
                                                       open→accept(行)→flush
                                                       （分页查询 + 流式写出）
```

> 共同点：变体侧可插拔，内核侧 open→accept→flush，切分点是边界数据结构。把"加一种新渠道/格式"从"克隆整个类"变成"写一个 @Component"。

---

## 4. 分布式场景适配

Session 模式的原生适用域是"单进程内的模块级重构"。跨进程需要适配：

| 场景 | 问题 | 适配方案 |
|------|------|---------|
| 微服务拆分 | 变体在服务 A，内核在服务 B，切分点数据要跨网络 | 切分点数据结构定义序列化协议（Proto/Avro），考虑 schema 演进 |
| 消息驱动 / 事件驱动 | 处理跨多个消息，状态无法放在一次调用的栈上 | Session 状态外部化（Redis/DB），用 correlation ID 关联 |
| Serverless / Lambda | 每次调用是新实例，单例复用前提不成立 | 改为无状态函数，依赖外部存储 |
| 跨服务调用 | 注册中心需跨服务发现 | 服务注册中心（Nacos/Consul）或 API Gateway 路由 |

---

## 5. 与现有架构的关系

本方法论不替代现有分层架构，而是为"多变体"场景提供更细粒度的切分指引：

| 本方法论 | 对应现有分层 | 说明 |
|---------|------------|------|
| 变体侧 | Adapter / Gate 层 | 各渠道适配器、各数据源读取器 |
| 切分点 | DTO / Domain Object | 边界数据结构，可序列化 |
| 稳定内核 | Service / Core 层 | 无状态处理逻辑 |

> 明确：本方法不是替代现有分层，而是为"多变体"场景提供更细粒度的切分指引。

---

## 6. 采集器实例参照

tccp-matcher 采集器是本方法论的一个完整落地实例：

```
ingest/executor/
├── read/                      ← 有界拉取（变体侧）
│   ├── BoundedSourceReader        supportType() 策略，hasNext() 终止
│   ├── SourceReaderRegistry       按 type 路由
│   └── JdbcSourceReader           DB 实现
├── stream/                    ← 无界订阅（变体侧）
│   ├── StreamIngester             supportType() 策略，长驻消费
│   └── StreamIngesterRegistry     按 type 路由（接口先行，暂无实现）
├── push/                      ← 同步推送（变体侧，非对称）
│   └── PushIngestHandler          按 pushToken 路由，无 source 适配器（接口先行）
├── pipeline/                  ← 稳定内核（不变侧）
│   ├── PairingPipeline            open(ctx)→Session，三模式共享
│   └── PairingPipelineImpl        无状态单例 + SessionImpl
└── IngestTaskExecutorImpl     ← 有界模式编排（读循环 + 完成语义）
```

三模式汇聚点：

```
BoundedSourceReader.read()  ─┐
StreamIngester poll 微批     ─┼─► PairingPipeline.open(ctx) → accept(row) → flush()
PushIngestHandler.ingest()  ─┘    转换 + pairKey 校验 + 攒批 + 三表事务写入 + 行级错误隔离
```

> 对照骨架：变体侧 = read/stream/push，切分点 = Map<String,Object> 行，稳定内核 = PairingPipeline。新增任意数据源，只要能产出 Map 行，就复用内核——内核零改动。
