# HotFM

在线收听 **美国** 与 **中国大陆** FM 电台的 Web 应用。Go 后端 + TypeScript (React) 前端，打包为单个二进制。
默认采用 Apple Music 风格界面：精简页头、独立搜索区域与电台列表、底部常驻播放器。
顶部“外观”提供“默认 / Default”的浅色 / 深色 / 跟随系统，以及保留收音机造型的经典 Hi-Fi 外观。

```
hotfm/
├── server/            Go API、目录同步、流代理、健康检测（单二进制，内嵌前端）
│   └── api/openapi.yaml   API 契约（前端类型由此生成，未来其它端复用）
└── web/               Vite + React + TypeScript 前端
```

## 快速开始

需要 Go 1.24+、Node 22+、pnpm。

```bash
cd web && pnpm install && cd ..
make dev            # API :18347 + Vite :18348，浏览器打开 http://localhost:18348
```

按 Ctrl+C 会关闭前后端并释放端口；也可用 `make dev-api` / `make dev-web` 单独启动。
端口占用或服务启动失败时会报错并结束整个开发任务，前端不会自动切换端口。

首次启动会从 [Radio Browser](https://www.radio-browser.info) 同步两国电台（数千条，视网络约 1–3 分钟），
之后健康检测器开始逐台探测。

```bash
make build          # 构建前端并内嵌，产出 ./bin/hotfm
./bin/hotfm         # 访问 http://localhost:18347
make test           # Go + 前端单元测试
make gen            # 修改 openapi.yaml 后重新生成 web/src/api/schema.d.ts
docker build -t hotfm . && docker run -p 18347:18347 -v hotfm-data:/data hotfm
```

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOTFM_ADDR` | `:18347` | 监听地址 |
| `HOTFM_API` | `http://localhost:18347` | Vite 开发代理的 API 地址；开发时修改 `HOTFM_ADDR` 需同步设置 |
| `HOTFM_DATA_DIR` | `./data` | SQLite 数据库与台标缓存目录 |
| `HOTFM_SYNC_INTERVAL` | `24h` | 目录同步间隔（按“上次成功同步时间”判断，重启不会重复/漏同步） |
| `HOTFM_STREAM_MODE` | `auto` | `auto`：普通 HTTPS 音频直连省带宽，HTTP 音频和 HLS 仍走代理；`proxy`：全部流经服务端（解决 https 混合内容、CORS、可取 Now Playing） |
| `HOTFM_MAX_STREAMS_PER_IP` | `4` | 每个客户端 IP 并发流上限 |
| `HOTFM_SECRET` | 随机 | HLS 代理 URL 的 HMAC 密钥；多实例部署时需固定 |
| `HOTFM_TRUST_PROXY` | 关 | `1` 时信任 `X-Forwarded-For`（部署在反向代理后） |
| `HOTFM_RADIOBROWSER_URL` | DNS 发现 | 固定某个 Radio Browser 镜像，如 `https://de1.api.radio-browser.info` |
| `HOTFM_USER_AGENT` | `HotFM/0.1 (...)` | 访问上游时的 UA（Radio Browser 要求可识别的 UA） |
| `HOTFM_DEBUG` | 关 | `1` 输出调试日志 |
| `HOTFM_DEV_CORS` | 关 | 开发时允许跨域 |

## 后端设计

- **同步** `internal/catalog`：分页拉取 `countrycode=US|CN&hidebroken=true`；
  - 频率解析：从台名/标签提取 `FM 101.7`、`101.7 FM`、`调频97.4`、`905fm` 等，校验 87.5–108；解析不到归入 `NET` 波段
  - 地区归一：中国 `state` 字段混有拼音、邮政式拼音（Kwangtung/Chekiang…）、城市名和中文，统一到省级；国家台归“全国”；港澳台条目排除。美国解析 `San Francisco CA`、`Chicago, IL` 等为州 + 城市
  - 去重：相同流地址合并；同名同地区同频的多个流合并为一台，其余作为**镜像**（alternates）
  - 上游消失的台软删除；软删除或失效超过 30 天物理删除
- **健康检测** `internal/health`：后台 16 并发持续探测
  - 普通流：读取前 32KB，要求音频类型或 MP3/AAC/OGG 帧特征；HLS：主列表 → 媒体列表 → 首个分片
  - 状态机 `unknown/ok → flaky → dead`：连续失败 ≥3 次且跨度 ≥12h 判定失效；任一次成功即恢复。失败退避 30m → 2h → 6h → 12h，正常台 12h 复查，失效台 24h 复查（可复活）
  - 连续失败 2 次起尝试镜像，成功则**自动切换主流地址**
  - 被动信号：代理成功输出音频记为成功；前端播放失败上报 `POST /stations/{id}/report` 触发优先复测
  - `dead` 台不出现在列表、刻度盘、搜索；按 id 仍可取到（收藏里显示“已失效”）。`GET /healthz` 查看统计
- **流代理** `internal/stream`：只代理目录中的地址；Shoutcast `ICY 200 OK` 兼容；剥离 ICY 元数据并通过 SSE 推送 Now Playing（中文台按 GB18030 解码）；HLS 播放列表改写为 HMAC 签名的代理地址
- **SSRF 防护** `internal/netguard`：连接时（含重定向、DNS 重绑定）拒绝私网/回环/链路本地等地址
- `GET /stations?freq=101.7` 按频率（±0.05 MHz）过滤，供主页频率搜索使用
- 搜索在后端扫描当前国家 / 省州的完整可用目录，再分页返回；名称支持部分匹配、忽略大小写 / 重音 / 空格和标点、多个关键词及少量英文拼写错误（4–7 个字母允许 1 次编辑，8 个以上允许 2 次，包括相邻字母颠倒）。中文短词和频率保持精确包含 / 数值匹配。默认按名称相关度优先、热度次之排序，也可按频率排序；城市、地区、流派仍支持关键词包含匹配，无需重同步或数据库迁移。

## 前端设计

- `src/player/engine.ts`：与 UI 无关的播放引擎（`<audio>` / hls.js 懒加载 / Safari 原生 HLS、自动重连、卡顿检测、SSE 元数据、Web Audio 电平）。移植到其它平台只需重写这一层
- `src/player/tuning.ts`：调台交互模型——拖动/滚轮/键盘调台时台间噪声随距离变化、当前台随指针远离而衰减；松手吸附 ±0.15MHz 内的台，否则停在 `SEARCHING` 1.2s 后自动锁定最近的台
- 搜索（`/` 或 `⌘K` / `Ctrl+K`）：独立浅色强调面板，与下方电台列表区分，显示当前搜索范围和目录电台数；输入电台名、城市或频率（`97.4`、`fm974`），200ms 防抖，支持中文输入法。默认搜索当前所选地区，未选省州时搜索当前国家的全部可用电台（例如 US 全部地区），不受已加载列表页数限制；`k exp`、`kxep` 可匹配 `KEXP`。无结果时可点击“搜索全部地区”扩大至所有国家。扩大搜索后标注范围并提供返回当前地区的入口，更换或清空关键词即恢复当前地区；空输入聚焦时显示最近搜索。
- 清除：输入框的“清空搜索”返回当前地区；列表的“清除筛选”同时清空关键词、省州限制并恢复热门排序，保留当前国家和正在播放的电台。
- 地区：主搜索框右侧常驻“切换地区”，支持中文、英文、拼音、首字母和美国州缩写，保留最近地区；手机采用底部抽屉。切换地区时退出搜索。
- 列表：电台 / 收藏 / 最近三个导航，通过分段控件直接选择热门或频率排序；不再提供流派筛选入口，普通关键词仍可匹配电台流派元数据。
- 播放器：Apple 界面底部常驻播放控制，详情中提供音量、收藏、睡眠定时和调频；经典外观保留实体调谐器。
- 外观：`src/styles/tokens.css` 提供 `apple`、`apple-dark`、`hifi`；外观菜单选择保存在 localStorage。旧版数据首次升级至 Apple 浅色，保留收藏、音量和历史，之后尊重用户的外观选择；首屏脚本同步主题避免闪烁。已下线的主题自动回到默认外观。
- 收藏、最近收听、音量等存 localStorage（结构带 `version`，便于将来接账号同步），最近收听最多保留 10 个电台，重复收听移至最前；启动时批量刷新失效状态；旧版预设中的电台自动合并进收藏，按电台 ID 去重
- 深链接 `/?c=US&r=california&s=<stationId>`，支持前进/后退

### 快捷键

`Space` 播放/停止 · `←/→` 微调 0.1 MHz（自动展开刻度盘） · `Shift+←/→` 搜台 · `T` 显示/隐藏刻度盘 · `F` 收藏 · `/` 或 `⌘K` 搜索 · `L` 切换地区 · `↑/↓` 音量 · `M` 静音 · `?` 快捷键面板

Apple 移动端：点击底部播放器展开详情。经典移动端保留显示屏左右滑动搜台和下拉收起。

## 数据来源

电台数据来自社区维护的 [Radio Browser](https://www.radio-browser.info)；播放时会向其上报点击以维持热度排序。
数码管字体 [DSEG](https://github.com/keshikan/DSEG)（SIL OFL 1.1）。
