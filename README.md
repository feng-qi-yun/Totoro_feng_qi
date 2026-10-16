# Totoro_feng_qi

这个项目fork自[yuyuyudlc/Totoro](https://github.com/yuyuyudlc/Totoro),旨在模拟更真实的跑步数据

---

## how to start

### 第一步：装 Node.js 与 pnpm

需要 **Node.js 20.9 或更高**（推荐 22）。pnpm 是包管理器，装完 Node 后再装它。

#### Windows

1. 打开 <https://nodejs.org>，下载 **LTS** 版 `.msi`，一路“下一步”安装；
2. 按 `Win + X` → 打开「终端」或「PowerShell」，输入下面两行确认装好：
   ```powershell
   node -v      # 应显示 v20.9.0 或更高
   npm -v
   ```
3. 启用 pnpm：
   ```powershell
   corepack enable pnpm
   ```
   若提示 `corepack` 不存在，改用：`npm install -g pnpm`

#### macOS

```bash
# 装 Node（二选一）
brew install node                 # 有 Homebrew
# 或者去 https://nodejs.org 下载 .pkg 安装

corepack enable pnpm              # 或 npm install -g pnpm
```

#### Linux（Ubuntu / Debian）

发行版自带的 Node 往往过旧，推荐用 nvm：

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL -l
nvm install 22
corepack enable pnpm              # 或 npm install -g pnpm
```

**确认**：`pnpm -v` 能打印出版本号（9 以上）就继续。

### 第二步：下载项目

```bash
git clone https://github.com/feng-qi-yun/Totoro_feng_qi.git
cd Totoro_feng_qi
```

没装 git 也行：打开仓库页面 → 绿色 `Code` 按钮 → `Download ZIP`，解压后进入该目录。

### 第三步：安装依赖

```bash
pnpm install
```

大约一两分钟。出现 `Done` 即可。

### 第四步：生成配置文件

```bash
cp .env.example .env
```

Windows PowerShell 用：

```powershell
Copy-Item .env.example .env
```

默认值就能用，不需要改。想改上游域名时才编辑 `.env`。

### 第五步：拿到 Token

Token 只能从你**已登录**的微信小程序进程内存里读出来，用这个纯本地小工具（不联网、不上传）：

| 系统 | 工具 |
| --- | --- |
| Windows | <https://github.com/SSSSSea6/open-totoro-token> |
| Linux | <https://github.com/feng-qi-yun/open-totoro-token_linux> |

Linux 示例：

```bash
git clone https://github.com/feng-qi-yun/open-totoro-token_linux.git
cd open-totoro-token_linux
# 先在微信里打开并登录「龙猫体育锻炼」小程序，不要关闭
sudo python3 memory_scanner_linux.py
```

它会打印一行约 100 字符、以 `WXXCX` 开头的 Token，复制下来。

- 读别的进程内存需要管理员/root 权限，所以 Linux 要 `sudo`；Windows 版按它自己的说明运行。
- **Token 有效期不长**（几十分钟量级），失效时回小程序重新登录、立刻重扫一次。

### 第六步：告诉程序你的机型

```bash
TOTORO_TOKEN=<刚才的Token> pnpm setup:device
```

Windows PowerShell：

```powershell
$env:TOTORO_TOKEN="<刚才的Token>"; pnpm setup:device
```

它会读取你**最近一次跑步记录**里用的机型与微信版本，写进 `.env`。

### 第七步：启动

```bash
pnpm dev
```

终端出现 `Ready` 后，浏览器打开 <http://localhost:3000>。这个终端就是程序本体，使用期间不要关。

---

## 怎么用

1. 粘贴 Token → 点「登录」；
2. 在「跑步任务」里选**任务**和**路线**；

**建议**
   湖区只采取西操的路线，东操太小会导致拟合度过低

3. 点「查看跑步数据」，核对里程、用时、配速、预估拟合度；
4. 点「确认并开始跑步」（此时服务端会创建跑步场次）；
5. **保持页面打开**：到点（开始时间 + 用时，最长约 25 分钟）后页面会自动提交成绩；
   中途关掉页面也行，下次打开会补交；
6. 提交完成后页面显示场次编号。

「早操任务」标签页是另一种打卡，用法相同：选点位 → 提交签到。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `pnpm: command not found` | 没启用 corepack：跑 `corepack enable pnpm`，或 `npm install -g pnpm` |
| 登录提示 **Token 失效** | Token 过期，或扫描脚本读到的是旧 Token：回小程序重新登录后立刻重扫 |
| `pnpm dev` 报端口被占用 | `pnpm dev --port 3001`，然后访问 <http://localhost:3001> |
| 提示「当前没有可用跑步任务」 | 不在任务时间范围/名额已满，回小程序确认 |
| 一直是「已排入待提交」 | 到点时间还没到；确认页面开着，到点后几秒内会自动提交 |
| 提示「学校要求开跑人脸校验」 | 学校开启了人脸/摄像头校验，程序按设计停下，不伪造校验资料 |
| 页面白屏或报错 | 先确认终端没有报错；再试 `pnpm install` 后重启 `pnpm dev` |

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 启动本机网页与 `/api` 服务 |
| `pnpm build` / `pnpm start` | 构建并用生产模式启动 |
| `pnpm lint` / `pnpm test` | 代码检查 / 运行测试（都不联网） |
| `pnpm setup:device` | 从最近一次跑步记录读取机型写入 `.env` |
| `pnpm sample:runs` | 只读拉取你自己的历史记录（用于核对/标定） |
| `pnpm derive:line` | 从真实记录导出「真实跑步线」，让轨迹形状更像人跑出来的 |

## 想更贴近真实（可选）

第一次真实跑过一次之后，可以导出你自己的跑步线——小程序里的官方路线折线往往只是操场边界，和实际跑的
跑道不是同一条线：

```bash
TOTORO_TOKEN=<Token> pnpm sample:runs --days 7 --detail --keep-tracks > local-data/latest.json
pnpm derive:line local-data/latest.json --spacing 15
```

之后生成轨迹就会沿这条线走（拟合度仍按官方路线计算）。原理与参数标定见 [`docs/DESIGN.md`](docs/DESIGN.md)。

## 目录说明

```
app/                页面与 /api 服务端接口
components/         前端组件（登录、跑步面板、早操面板、Markdown 弹窗）
lib/server/         服务端逻辑：登录、任务、轨迹生成、待提交、上游请求代理
lib/store.js        前端登录态（浏览器 localStorage）
scripts/            机型探测、真实记录采样、跑步线导出
local-data/         本机数据（Token、待提交任务、采样结果），已 gitignore，不要外传
docs/DESIGN.md      实现原理与参数标定说明
```

## 说明

- 本项目是 [yuyuyudlc/Totoro](https://github.com/yuyuyudlc/Totoro) 的个人 fork，已改为本机单机运行。
- 请只用自己的账号使用；`local-data/` 里有你的 Token 与真实轨迹，注意保护。

### 本项目修改了什么？

- 运行在本地
- 添加了自定义机型功能
- 添加自定义路线功能
- 修改了一些参数让他更真实

## 许可证

[MIT](LICENSE) © 2026 feng-qi-yun

仅供学习交流使用；请遵守所在学校的规定，使用本程序产生的一切后果由使用者自行承担。