# keeprules

交互式安装 Coding Agent 规则文件的 CLI 工具。

- 仓库：https://github.com/fb0sh/keeprules
- 作者：fb0sh@outlook.com

## 快速开始

在目标项目根目录执行：

```bash
# 官方仓库
npx keeprules add

# 任意第三方 GitHub 仓库（默认 main 分支）
npx keeprules add user/repo
npx keeprules add https://github.com/user/repo

# 指定分支
npx keeprules add user/repo#branch
```

不写 `add` 时（`npx keeprules`）等同于安装官方规则。要求 Node.js >= 18，并需要在交互式终端中运行；建议安装 `git` 以支持 API 不可用时的回退。

## 使用方法

安装向导会：

1. **从 GitHub 拉取规则**：默认是官方仓库 `fb0sh/keeprules` 的 `main` 分支，也可以用 `add user/repo` 指定任意仓库。CLI 优先用 GitHub Contents API 的 raw media type 下载 `rules/` 下的 `.md` 文件；API 失败或受限时回退到浅克隆（SSH 优先，HTTPS 再回退；`--depth 1 --filter=blob:none --sparse` + `sparse-checkout` 只检出 `rules/`）。单次 API/git 操作 15 秒超时。
2. 列出所有可用规则，默认不选中。
3. 询问是否把规则引用写入 `AGENTS.md`。
4. 把选中的规则文件写入当前项目的 `rules/` 目录；已存在的文件用本次远程内容覆盖。
5. 必要时补充 `.gitignore` 中的 `/tmp/` 规则。

**远程规则始终优先。** 选中的规则文件最终一定与本次从仓库获取的内容一致；本地修改会被覆盖，未选中的规则文件保持不变。

> **需要联网。** npm 包里不再包含规则文件，规则总是从仓库获取。
> 拉取失败会直接报错退出，不会退回任何本地副本。私有仓库需要设置
> `GITHUB_TOKEN`（API 限额和私有仓库）或本机 git 凭据；公开仓库通常不需要。

`--help` 和 `--version` 不联网，可以离线使用。

安装后的项目结构：

```text
project/
├── AGENTS.md          # 引用 rules/ 下的规则（可选）
├── rules/
│   ├── KEEPTIDY.md
│   ├── KEEPSECURED.md
│   └── KEEPTRACK.md
├── .gitignore
└── ...
```

### 快捷键

- `↑↓`：移动光标
- `空格`：选中 / 取消当前规则
- `a`：全选 / 取消全选
- `回车`：确认
- `Esc` / `Ctrl+C`：取消

`Select All` 会显示 `○ 未选中`、`◐ 部分选中`、`● 全部选中` 三种状态。

## 可用规则

规则列表在运行时获取，所以随时可能变化。当前仓库里有：

| 规则 | 安装路径 | 说明 |
| --- | --- | --- |
| `KEEPLEAN` | `rules/KEEPLEAN.md` | 精简变更（必要性判断、复用优先、最小可维护改动、安全与正确性边界） |
| `KEEPTIDY` | `rules/KEEPTIDY.md` | 工程卫生与资源管理（项目级 tmp、任务隔离、资源回收、Git 安全、进程管理） |
| `KEEPSECURED` | `rules/KEEPSECURED.md` | 安全与敏感信息保护（凭证与隐私、外部通信、权限边界、生产环境和高风险操作） |
| `KEEPTRACK` | `rules/KEEPTRACK.md` | 跨会话问题跟踪（提问澄清后记录到 `docs/agent-issues/`、记录与执行分别授权、显式批准后才动手） |

新增规则只需要往仓库 `rules/` 里加一个 `.md` 文件，**不需要更新清单，也不需要发版**。

选择 `KEEPTIDY` 时，会确保 `.gitignore` 包含：

```gitignore
# keeprules: 临时目录
/tmp/
```

所有规则都可以选择是否在 `AGENTS.md` 中添加引用。引用使用 `<!-- keeprules:start -->` / `<!-- keeprules:end -->` 区块；首次运行时追加，之后只改写该区块，区块外的用户内容保持不变。区块内的链接指向 `rules/<文件>`：

```markdown
<!-- keeprules:start -->
## KEEPTIDY

Follow the KEEPTIDY rules defined in [rules/KEEPTIDY.md](./rules/KEEPTIDY.md).

These rules are mandatory for all Coding Agents working in this repository.
<!-- keeprules:end -->
```

再次运行时会复用同一个区块并合并内容：之前已引用的规则会保留，指向旧路径（例如根目录的 `KEEPTIDY.md`）的链接会被修正为 `rules/KEEPTIDY.md`。

### 向 `AGENTS.md` 注入核心约束

规则可以在正文里声明一段要跟着引用一起写进 `AGENTS.md` 的内容，用一对 HTML 注释标记：

```markdown
<!-- keeprules:agents -->
### Issue capture

- Refine and clarify the user's description.

### Issue execution

- ALWAYS ask for explicit approval before starting work.
<!-- /keeprules:agents -->
```

安装时这段内容渲染在 `## 规则名` 和链接行之后；没有这段标记的规则行为不变，仍然只有标题和链接。

约束：

- 每个规则最多一个标记区，标记必须成对；空标记区等同于没有。
- 允许 `###` 及更深的标题，**不允许 `#` / `##` 标题**——引用块按 `##` 切分，注入的二级标题会被当成另一条规则的小节永久保留。
- 最多 40 行、2000 字符，且不能包含 `keeprules` 自己的块标记。
- 标记区格式错误时，整批安装会在写入任何文件之前失败，`AGENTS.md` 保持原样（不论这条规则是否声明 `agents` 步骤）。
- 注入内容随规则一起被远程覆盖：改规则、删标记、重跑都会同步到已选规则的区块，不残留旧行。
- 确认安装前会先列出即将注入的内容（「AGENTS.md 将追加的核心约束」），第三方仓库的规则也能先审再装。

### 从第三方仓库安装

任何 GitHub 仓库都可以作为规则来源，默认分支是 `main`：

```bash
npx keeprules add user/repo
npx keeprules add https://github.com/user/repo
npx keeprules add user/repo#dev          # 指定分支
npx keeprules add user/repo#release/1.0  # 分支名可以带斜杠
```

也可以直接传完整的 GitHub URL，或带 `.git` 后缀的仓库地址。私有仓库需要
`GITHUB_TOKEN`（API 请求头；clone 回退时通过 git HTTP 头传入，不写进 URL）：

```bash
GITHUB_TOKEN=ghp_xxx npx keeprules add user/private-repo
```

（PowerShell 中写成 `$env:GITHUB_TOKEN="ghp_xxx"; npx keeprules add user/private-repo`。）

## 命令行选项

```bash
keeprules                                  # 进入交互式安装（官方仓库）
keeprules add                              # 同上
keeprules add user/repo                    # 第三方仓库
keeprules add https://github.com/user/repo # 完整的 GitHub URL
keeprules add user/repo#branch             # 指定分支
keeprules --help                           # 显示帮助
keeprules --version                        # 显示版本
```

## 添加规则

官方仓库和第三方仓库使用同一套规则格式：往 `rules/` 目录里放 Markdown 文件即可，**不需要 `index.json`**。

```markdown
---
id: myrule
name: MY_RULE
description: 我的 Coding Agent 规则说明
postInstall:
  - gitignore
  - agents
---

# MY_RULE 正文...
```

- `id`：唯一标识
- `name`：显示名称
- `description`：选择界面里的说明
- `postInstall`：可选，目前只有 `gitignore` 和 `agents`

正文里用 `<!-- keeprules:agents -->` … `<!-- /keeprules:agents -->` 包住的内容，会随 `agents` 步骤写进 `AGENTS.md`（见[向 `AGENTS.md` 注入核心约束](#向-agentsmd-注入核心约束)）。

没有 frontmatter 也能用：`id` / `name` 取文件名，`description` 取正文第一行。

### 第三方仓库的最小规范

```text
your-repo/
└── rules/
    ├── MY_RULE.md
    └── ANOTHER_RULE.md
```

1. 规则文件直接放在仓库的 `rules/` 目录下，不要放子目录。
2. 每个文件以 `.md` 结尾，其他文件会被忽略。
3. 推荐写 frontmatter；缺少 frontmatter 时用文件名作为 `id` / `name`，正文第一行作为 `description`。
4. 默认拉取 `main` 分支；仓库使用其他默认分支时，用 `user/repo#branch` 指定。
5. 不需要 `index.json`、构建步骤或发布流程。

### 规则是怎么分发的

```
GitHub 仓库的 rules/*.md
        ↓  API raw 下载；失败时 git 浅克隆 + sparse checkout
项目的 rules/*.md（选中项始终采用远程内容）
```

`rules/` 不随 npm 包发布，只在仓库里。所以改了规则立刻对所有人生效，不用 `npm publish`。

规则文件名不能只靠大小写区分（`RULE.md` 与 `rule.md`）：macOS 和 Windows 的文件系统不区分大小写，两个规则会写成同一个文件，所以启动时直接报错。规则按码点排序，与系统 locale 无关。

## 远程覆盖策略（Remote Always Wins）

每次 `add` 都重新从远程获取规则目录和规则内容，不做版本比较、内容合并或更新确认。对用户选中的规则：

| 本地状态 | 行为 | 反馈 |
| --- | --- | --- |
| 文件不存在 | 新建 | `已安装` |
| 内容不同（含未提交修改） | 用远程内容覆盖 | `已更新（远程覆盖）` |
| 内容相同 | 跳过实际磁盘写入 | `已是最新` |

覆盖写入前会先校验**全部选中规则**的远程内容、`postInstall` 名称和目标路径。任一校验失败时，本次不写入任何文件、不执行 `postInstall` 步骤，本地文件保持原状。

规则文件通过 `rules/` 目录内的临时文件 + 原子替换写入：

- 写入失败时保留原文件，并清理临时文件。
- 目标规则文件或 `rules/` 目录是符号链接时拒绝写入。
- 规则名必须是 `rules/` 下的普通文件名，不能包含路径分隔符，也不能使用 Windows 保留名（如 `CON.md`）或 `<>:"|?*` 等字符。
- `AGENTS.md` 和 `.gitignore` 使用同一套安全写入：同目录临时文件 + 原子替换，写入前校验目标与父目录；符号链接目标会被拒绝；内容未变化时不写盘，并保留原有 BOM 与 LF/CRLF 换行。

其他行为保持不变：

- 内容一致的规则仍会执行它声明的步骤：这些步骤维护的是项目级约定（`.gitignore`、`AGENTS.md`），和规则文件本身无关。
- `AGENTS.md` 只改写 `<!-- keeprules:start -->` / `<!-- keeprules:end -->` 区块，区块外的用户内容保持不变。
- `gitignore` 自动执行；`agents` 会先问你。
- 写入阶段单条规则失败不影响其他规则继续写入；校验阶段任一规则失败则整批不写入。
- 未成功写入的规则不会被写进 `AGENTS.md`。
- 未选中的本地规则文件不受影响。
- 三处取消（选规则 / 步骤确认 / 最终确认）返回同一个结果，只会提示一次「已取消」。

顺带一提，`AGENTS.md` 里的引用块是**可自愈**的：重跑时保留之前引用过的规则，并把 0.1.x 写在根目录的旧链接（`./KEEPTIDY.md`）纠正成 `rules/KEEPTIDY.md`。

## 代码结构

一共 7 个文件，依赖是一条直线：

```text
bin/keeprules.js   argv → 意图、终端打印、退出码
src/flow.js        流程：选规则 → 问步骤 → 确认 → 安装 → 报告
src/install.js     写入策略：远程覆盖、原子替换、两个步骤怎么写、报什么
src/rules.js       规则解析：frontmatter → 规则记录（不碰磁盘和网络）
src/picker.js      选择器：文本宽度 + 状态机 + 终端适配
src/prompts.js     把 clack 和选择器的「取消/拒绝/作答」统一
src/remote.js      解析来源；API raw 优先，失败回退 git clone 并读取 rules/
```

依赖方向：`bin → flow → install`，`bin → prompts → picker`，`bin → remote → rules`。
`rules.js` 只解析、不碰磁盘和网络，所以能直接用内存夹具测试。

## 常见改动

| 想改什么 | 改哪里 |
| --- | --- |
| 规则装到哪个目录 | `src/install.js` 的 `RULES_DIR`（唯一一处） |
| 默认规则从哪里拉 | `src/remote.js` 的 `DEFAULT_SOURCE` / `DEFAULT_BRANCH` |
| `AGENTS.md` 引用块的格式 | `src/install.js` 的 `renderBlock` / `renderSection` |
| 规则注入 `AGENTS.md` 的标记区与上限 | `src/install.js` 的 `agentsNotes`（`NOTES_MAX_LINES` / `NOTES_MAX_CHARS`） |
| 加一个步骤 | `src/install.js` 的 `STEPS` 加一项 + 写一个函数 |
| 打印样式 | `bin/keeprules.js` 的 `printer` |
| 选择器交互 | `src/picker.js` |

## 跨平台

支持 Linux、macOS 和 Windows：

- 路径一律用 `path.join` / `path.posix` 处理，写入 Markdown 的链接固定使用 `/`。
- 追加 `.gitignore` 与 `AGENTS.md` 时沿用文件原有的换行（CRLF/LF）与 BOM。
- 排序用码点比较，不依赖 locale 与 ICU 版本。
- 不依赖 shell，不使用 `chmod`、`/dev/*`、`os.tmpdir()` 等平台特定行为。
- 回退路径通过 Node 的 `execFile` 调用本机 `git`，不经过 shell；需要支持 sparse checkout 的 git（2.25+）；API 路径不需要 git。
- 原子替换只使用 Node 自带的 `rename`；符号链接检查使用 `lstat` / `realpath`，不依赖平台特定命令。

CI 在 Ubuntu / macOS / Windows × Node 18/20/22 上运行 `npm test`。

## 本地开发

```bash
git clone https://github.com/fb0sh/keeprules.git
cd keeprules
npm install
npm test

node bin/keeprules.js --help
node bin/keeprules.js --version
```

### 本地调试

```bash
# 在仓库内
npm link

# 在测试项目中
keeprules add

# 从第三方仓库测试
keeprules add user/repo#dev

# 解除链接
npm unlink -g keeprules
```

### 打包测试

```bash
npm pack

mkdir demo && cd demo
npm init -y
npm install ../keeprules-3.2.0.tgz
npx keeprules add
```

## 发布

```bash
npm test
npm login
npm view keeprules version   # 404 表示包名可用
npm publish

# 发布后验证
npx keeprules@latest --version
```

如果名称日后被占用，可改用 scope：

```bash
npm publish --access public
npx @fb0sh/keeprules add
```

## License

MIT
