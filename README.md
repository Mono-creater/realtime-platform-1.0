# 城轨受电弓碳滑板监测平台 1.0

面向城市轨道交通受电弓碳滑板在线监测的**双包上报协议 + 告警运维闭环**平台实现，
配套论文《城轨受电弓碳滑板监测平台的双包上报协议与告警运维闭环》。

平台在**窄带、时断车地链路**约束下，用 31 B/次的事务预算解决模拟量数据的
**可追溯性**与**告警可信度**问题。

---

## 一、核心能力

| 层面 | 能力 | 对应论文 |
|---|---|---|
| **协议** | 主包＋异常子包双包上报（正常 31 B / 异常 62 B）、D2001—D2022 寄存器映射、状态字位域（bit6 扩展协议 / bit7 子包有效）、8 种异常位图语义 | §1、表2、表3 |
| **编码** | ×10 定点编码（½LSB = 0.05）、三路全量程最大量化误差 0.050 0、双重钳位规避 Modbus 异常码 4 | §1.3、表4 |
| **链路** | **回绕感知序号连续性判据**（式1）、丢包率估计（式2）、三态数据质量码 GOOD/STALE/BAD（式3）、指数退避重连（式4）、写入—回读校验 | §2.1、§2.2 |
| **判据** | **EWMA 趋势检测**：3 点中值 → EWMA → 窗口差分 `roc=(Zᵢ−Zᵢ₋W)/W`，阈值通道与变化率通道**共用同一滤波序列**；统计窗口与轮询周期**解耦**；式(6) σr 与式(12) δmin 解析控制限；15 s 冷启动保护（P117，误报率评估类试验启用） | §2.3、§2.4、式(5)(6)(12) |
| **运维** | 工单状态机（表5）、健康指数（式7）、剩余寿命 RUL（式8）、MTTR（式9）、KPI 闭环 | §3 |
| **上报** | 自适应变周期（正常 Pn=10 s ⇄ 缓变预判 Pa=1 s，式10）、丢包率 Wilson 置信区间（式11） | §4.2、§4.3 |
| **闭环** | 判据/链路/工单引擎接入实时采集主链路（`pipeline.js`），major/critical 告警自动建单；前端「运维中心」可视化 EWMA 标定、链路质量、工单状态机、RUL、KPI | §2、§3 |
| **图传** | 黑盒子 HTTP multipart 上传（图片/短视频 + 传感器键值）→ 落盘 + JSON 索引 → 前端 300 ms 增量轮询；`eventId` 幂等、原子写、设备令牌 | 图传链路（独立于 31 B 遥测） |

---

## 二、快速开始

```bash
npm install
```

**Windows 用户可直接双击：**

| 脚本 | 用途 |
|---|---|
| `启动平台1.0.bat` | 启动平台服务（含环境自检，不跑测试） |
| `论文数值复现验证.bat` | 一键运行单元测试 + 论文全部数值复现验证 |
| `启动PLC模拟器.bat` | 单独启动 Modbus TCP 从站模拟器 |

默认监听 `http://localhost:3000`（由 `.env` 的 `PORT` 控制）。

> 无数据库也能跑：未配置 `DATABASE_URL` 时自动退化为内存模式，演示数据与告警功能照常可用。

**页面**

| 路由 | 页面 | 说明 |
|---|---|---|
| `/monitor_line` | 线路监控（默认） | 1~13 号线切换（演示口径的投运/运营/告警/乘车率）+ 三张实时表（告警/预警/受电弓状态） |
| `/monitor_global` | 全局监测 | 统计卡、实时告警、7 天趋势、类型分布 |
| `/monitor_car` | 环境参数 | 三路传感器、受电弓姿态、双环 PID + Z-N 整定；晚开页面自动回填最近 50 点趋势 |
| `/fault_overview` | 故障总览 | 检索、批量删除、单条 PDF |
| `/ops_center` | **运维中心** | 链路质量、EWMA 判据与 σ 标定、自适应周期、RUL、工单流转、告警确认 |
| `/box_alarm_monitor` | **黑盒告警** | 图传：图片/视频预览，300 ms HTTP 增量轮询 |
| `/moterline_pantograph` | 受电弓详情 | 告警构成饼图（真实数据）+ 故障预警滚动板 |
| `/pantograph-warning` | 告警详情 | 运行上下文（车号/区站/公里标）+ 区站路线条 |

> 演示缓变工况：`POST /api/simulation/inject {"sig":"temperature"}` —— 注入 8.9 ℃/min 线性缓变，
> 约 60 s 后 EWMA 变化率通道告警（此时温度仍远低于 80 ℃ 阈值），约 9 min 后阈值通道才越限。

---

## 三、论文数值复现

平台的判据实现均可用脚本独立复算，结果与论文逐项对齐：

| 论文出处 | 论文值 | 平台复现值 |
|---|---|---|
| §4.2 单次事务 | 31 B / 62 B | 31 / 62 B |
| §4.2 2 s 轮询日流量 | 1.339 / 2.678 MB（SI 制） | 1.339 / 2.678 MB |
| §4.2 压缩倍数（双基线：16 位逐样本 27 B @0.1 s / 100 Hz 波形 33 B @0.01 s） | 17.4 / 212.9（满异常 8.7 / 106.5） | 17.42 / 212.9（8.71 / 106.5） |
| §4.2 自适应带宽 λ=5% | 0.388 MB/d，节省 85.5%（λ=1% 节省 89.1%） | 0.388 MB/d，85.5% / 89.1% |
| 表8 序号边界用例（5 例） | 1→0 / 1→0 / 2→2 / 3→3 / 65535→0 | **完全一致（含"修正前"列）** |
| §4.3 Wilson 零缺口 0/100 | 3.7% | 3.70% |
| 式(6) σr | ≈0.4714（不含 σeff） | 0.4714 |
| 式(12) δmin | ≈1.41 | 1.4142 |
| §4.4 噪声边界 | σ ≤ 1.41 | 1.414 |
| §4.4 纯噪声误报（P115/P117） | 0 条（15 s 冷启动保护后）；未启用保护 7~8 条 | **0 条（保护后）/ 8 条（保护关）** |
| 表10 3/5/10 ℃/min 检出时延 | 61 s | **61 s** |
| 表10 2 ℃/min 检出时延 | 65 s | **65 s** |
| 表15 健康指数（7 行） | 100/93/81/68/44/14/0 | **完全一致（含扣分明细）** |
| §4.5 MTTR | 71.5 min（论文 P143 示例口径 84.2 min 无数据集归档，平台保留 71.5） | 71.5 min |
| §4.5 RUL 误差中位 | ≤0.1% | −0.1% ~ 0.1% |

```bash
npm test           # 单元测试（118 项）
npm run verify     # 论文数值复现验证（全部）
```

### 3.1 测试分层

| 命令 | 层级 | 说明 |
|---|---|---|
| `npm test` | 单元 | 118 项纯函数/引擎断言，零依赖、毫秒级 |
| `npm run test:store` | 存储 | 9 项：快照生成、损坏回退、保留份数裁剪 |
| `node tests/smoke_routes.js` | 路由冒烟 | 14 项，只挂载 router，不连 DB/WS |
| `npm run test:int` | **HTTP + WS 集成** | 32 项，启动真实 `server.js` 子进程（内存模式），覆盖告警增删查、增量帧、订阅投递、工单白名单、静态回退与缓存头、CSV 导出 |
| `npm run test:persist` | **重启持久化** | 6 项：建单 → 停服 → 重启，工单与编号延续 |
| `npm run test:auth` | **认证与角色** | 13 项：未登录 401、密码错误、operator 可写、viewer 403、登出吊销 |
| `npm run test:media` | **图传链路** | 13 项：multipart 上传、落盘、列表/增量、`eventId` 幂等、静态访问、重启恢复 |
| `npm run test:e2e` | **前端 E2E** | 18 项，真实 Chrome（CDP）跑 6 个页面，断言 KPI 卡、实时数据点、表格行、图表画布、CSP 违规 |
| `npm run test:all` | 全量 | 八套串联，共 **223 项**（E2E 需本机 Chrome，缺失时自动 SKIP） |

集成/E2E 均自起服务并隔离环境：`DATABASE_URL=''`（不碰现网库）、临时 `RUNTIME_STATE_FILE`、固定 `WS_SENSOR_MODE=subscribe`。

---

## 四、目录结构

```
realtime-platform1.0/
├── 论文-平台技术对照与升级说明.md   ← 论文技术点 ↔ 代码的逐项对照索引
├── package.json
│
├── ── 核心判据模块（纯函数，无第三方依赖）──
├── ewma-trend.js          EWMA 趋势检测 + 式(5)(6)(12) 解析式 + 窗口解耦 + 冷启动保护
├── health-index.js        健康度（滚动窗口 + 部件告警加权，式7 口径）
├── rul-predictor.js       最小二乘退化速率 β 与 RUL（式8）
├── adaptive-period.js     自适应变周期状态机与带宽核算（式10）
├── alarm-engine.js        告警引擎：中值→EWMA→分级→取高→抑制→留痕
├── link-monitor.js        回绕感知序号判据（式1）+ 质量码（式3）+ Wilson（式11）
├── maintenance.js         工单状态机（表5）+ 健康指数 + RUL 接入
├── standards.js           标准公式、分级阈值、KPI、Wilson 区间
│
├── ── 服务与协议 ──
├── server.js              Express + Socket.IO 服务端（采集/告警/控制/PDF）
├── pipeline.js            v2 引擎单例：采集链路 → EWMA 判据 / 链路 / 工单 / 自适应 / RUL
├── runtime-store.js       运行态快照持久化（data/runtime-state.json，零表结构变更）
├── sim-source.js          模拟数据源（稳态游走 + 稀发线性缓变）
├── plc-packet.js          Modbus 寄存器映射与编解码
├── plc-simulator.js       Modbus TCP 从站模拟器
├── upgrade-routes.js      REST 接口（/api/v2/*，复用实时 pipeline）
├── security.js            令牌 / 限流 / 审计 / 上传白名单
├── demo-warnings.js       演示告警种子（含清理与上下文合并）
├── control-engine.js      双环 PID 控制引擎
├── control-engine-v2.js   PID 安全整定（Z-N 折减 / IMC）
├── plc-program/           汇川 Easy320 PLC 程序（Easy320_main.st）
│
├── src/                   前端（Vue 3 + Element Plus + DataV）
├── dist/                  前端构建产物（server.js 直接托管）
├── tests/                 单元测试与 REST 冒烟
├── tools/                 论文数值复现脚本 + UI 验证脚本
└── prisma/                数据库 Schema
```

---

## 五、技术栈

- **后端**：Node.js 20.19+ / 22.12+、Express、Socket.IO、modbus-serial、Prisma
- **前端**：Vue 3、Vite、Element Plus、ECharts、DataV-Vue3
- **协议**：Modbus TCP（FC03 读 / FC16 写）
- **硬件侧**：汇川 Easy320 PLC + GL10-4AD（三路 4～20 mA 变送器）

---

## 五之二、1.1 优化记录（2026-10-23）

1.0 的算法层完整但**未接线**：v2 引擎只被 `/api/v2/ingest` 驱动，前端 0 处引用。1.1 补齐了"最后一公里"：

| 类别 | 变更 | 验证 |
|---|---|---|
| **主链路** | `pipeline.js` 单例接入 PLC 采集 / 旧固件回退 / 模拟器三条路径；`/api/v2/*` 读同一实例 | 起服务 8 s 后 `/api/v2/link` packets>0、`/api/v2/kpi` 完整率=1 |
| **运维闭环** | major/critical 告警自动建单（同信号同等级 10 min 冷却）；`/api/v2/overview` 一次取全量运行态 | 注入缓变 75 s → 1 条 roc 告警 + 1 张工单 + 自适应转 SUSPECT |
| **前端** | 新增「运维中心」页（链路/EWMA/自适应/RUL/工单/告警）；全局监测、受电弓详情去静态化；线路监控按需求保留 1~13 号线演示口径 | 无头 Chrome 渲染：6 张 KPI 卡、工单 WO00001、告警表 major 行均可见 |
| **持久化** | 工单/告警编号/链路累计/告警上下文写入 `data/runtime-state.json` | 重启后 `/api/warning/:id` 上下文（车号/区站/公里标）不丢 |
| **模拟器** | 30% 概率越限 → 稳态游走 + 稀发线性缓变（8.9 ℃/min）；模拟告警用 `SIM_SENSOR` 不落库 | 运行 2 min 库计数不变；`/api/simulation/inject` 可手工触发 |
| **缺陷修复** | 切 real 失败返回真实模式、详情页时间 08:00:00、清模拟只清内存、工单接口任意方法、KPI 可用率恒 1、UTC 分日、湿度编码未钳位、空库假饼图 | 见 `平台功能梳理与待完善清单.md` 修复记录 |

回归：单元测试 **118/118**、REST 冒烟 **14/14**，与论文数值逐项对齐不变。

### 1.2 工程化优化（同日）

| 类别 | 变更 | 收益 |
|---|---|---|
| **生产安全** | `ALLOW_SIM_FALLBACK`（`NODE_ENV=production` 默认关闭）：PLC 连不上时保持真实模式、质量码 BAD、持续退避重连，不再用模拟数据顶替 | 杜绝"界面有数、其实是假数据" |
| **带宽** | `fullUpdate` 拆为 `full` / `delta` 两种帧，单条变更只发 1 条记录（实测 4.5 KB → 0.5 KB，500 条列表时约 100 KB → 0.5 KB） | 高频告警不再刷带宽 |
| **前端状态** | 新增 `src/stores/alarms.js`（Pinia）：全站唯一数据源，5 个页面共享，切页不再重复 `GET /api/history` | 请求数降为 1，增删自动同步各页 |
| **可观测** | `GET /api/health`：模式、PLC 连接、重连倒计时、DB、链路质量、内存占用 | 便于探针与排障 |
| **安全头** | CSP（`script-src 'self'`）、`X-Frame-Options: DENY`、`Permissions-Policy`，可用 `CSP_POLICY` 覆盖 | 降低 XSS/点击劫持面 |
| **缓存** | `index.html` no-store、`/assets/*` immutable | 重新构建后不再加载旧页面 |
| **WS 安全** | Socket.IO 不再硬编码 `origin:"*"`：未配 `CORS_ORIGIN` 时只接受同源；配置后按白名单并在握手阶段校验 Origin | 跨站无法连实时通道 |
| **协议收敛** | 删除废弃的 `addWarning` / `updatePie` 上行事件与 `pieData` 字段；WS 只做下行推送 | 攻击面减少，首帧字段精简为 4 个 |
| **订阅投递** | `sensorData` 改为按订阅投递（默认）：只有 `MonitorCar` 声明 `subscribe(['sensor'])` 才收；`WS_SENSOR_MODE=broadcast` 可一键回退 | 6 页同开时无效投递从 6 份降到 1 份（实测 5 帧 vs 0 帧） |
| **时钟健康** | `clock-guard.js`：NTP 四时间戳校时（HTTP Date 兜底）+ `/api/alert` 的 `clientTime` 偏差统计；运维中心新增时钟卡 | 平台偏移 +5 ms、上报端偏差 p95 29.9 s、降级 1 条 |
| **认证与角色** | `auth.js`（默认关闭）：`operator` 可写、`viewer` 只读；HttpOnly 签名 Cookie，登出即吊销令牌；登录失败限流 | 未登录 401、viewer 写 403、登出后旧 Cookie 立即失效 |
| **快照自愈** | 每日快照保留 7 份；主文件损坏自动回退最近一份，`/api/health.runtime.restoredFrom` 可见 | 主文件写成非法 JSON → 自动恢复工单 |
| **工单导出** | `GET /api/v2/orders/export?format=csv`（带 BOM、防公式注入），运维中心有「导出 CSV」入口 | 集成测试校验 BOM 与表头 |
| **长期运行** | 判据告警内存上限 2000 条，避免数组无限增长 | — |
| **图传链路** | 合并 `图传/` 原型：`POST /api/upload-alarm`、`GET /api/get-alarm-list`、黑盒告警页；加固为原子写 + `eventId` 幂等 + 设备令牌 + 后台暂停轮询 | `npm run test:media` 13 项 |

**启用认证**：

```bash
# .env
AUTH_ENABLED=true
AUTH_OPERATOR_USER=op
AUTH_OPERATOR_PASS=<强密码>
AUTH_VIEWER_USER=view
AUTH_VIEWER_PASS=<只读密码>
AUTH_PUBLIC_READ=true      # 未登录可看大屏、不可写；false 则读也需登录
```

未登录访问任意页面会跳到 `/login`；登录后左下角显示账号与角色。

---

## 六、口径说明

- **健康指数**为多指标加权的**代理指标**（在缺少滑板厚度直接测量时使用），
  权重与统计窗口属工程初值，投运前应按线路实测数据标定。
- **变化率阈值**不能脱离传感器噪声水平单独设定，投运前须按式(12) 校核
  （`GET /api/v2/ewma/selfcheck` 可直接给出"判据是否可分辨"的结论）。
- 平台数据不含区站起讫里程，告警详情页的"预计位置"由公里标/定位点号做**工程近似**，
  界面以「预计」标注，不作为精确定位结论。

---

## 七、许可

仅供学习与研究使用。
