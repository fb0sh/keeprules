# keeprules

交互式安装 Coding Agent 规则文件的 CLI 工具。

- 仓库：https://github.com/fb0sh/keeprules
- 作者：fb0sh@outlook.com

## 快速开始

在目标项目根目录执行：

```bash
npx keeprules add
# 或
npx keeprules
```

要求 Node.js >= 18，并需要在交互式终端中运行。

## 使用方法

安装向导会：

1. 列出所有可用规则，默认不选中。
2. 询问是否把规则引用写入 `AGENTS.md`。
3. 把选中的规则文件复制到当前项目的 `rules/` 目录。
4. 必要时补充 `.gitignore` 中的 `/tmp/` 规则。

已有的目标文件不会被覆盖。安装过程不访问网络。

安装后的项目结构：

```text
project/
├── AGENTS.md          # 引用 rules/ 下的规则（可选）
├── rules/
│   ├── KEEPTIDY.md
│   └── KEEPSECURED.md
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

| 规则 | 安装路径 | 说明 |
| --- | --- | --- |
| `KEEPTIDY` | `rules/KEEPTIDY.md` | 工程卫生与资源管理（临时目录、Git 安全、进程清理、破坏性操作检查点） |
| `KEEPSECURED` | `rules/KEEPSECURED.md` | 安全与敏感信息保护（凭证、日志脱敏、禁止外传、生产环境约束） |

选择 `KEEPTIDY` 时，会确保 `.gitignore` 包含：

```gitignore
# keeprules: 临时目录
/tmp/
```

所有规则都可以选择是否在 `AGENTS.md` 中添加引用。引用使用 `<!-- keeprules:start -->` / `<!-- keeprules:end -->` 区块，只追加，不覆盖已有内容。区块内的链接指向 `rules/<文件>`：

```markdown
<!-- keeprules:start -->
## KEEPTIDY

Follow the KEEPTIDY rules defined in [rules/KEEPTIDY.md](./rules/KEEPTIDY.md).

These rules are mandatory for all Coding Agents working in this repository.
<!-- keeprules:end -->
```

再次运行时会复用同一个区块并合并内容：之前已引用的规则会保留，指向旧路径（例如根目录的 `KEEPTIDY.md`）的链接会被修正为 `rules/KEEPTIDY.md`。

## 命令行选项

```bash
keeprules            # 进入交互式安装
keeprules add        # 同上
keeprules --help     # 显示帮助
keeprules --version  # 显示版本
```

## 添加规则

在 `rules/` 下放一个 Markdown 文件即可，不需要改代码：

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

没有 frontmatter 也能用：`id` / `name` 取文件名，`description` 取正文第一行。

规则文件名不能只靠大小写区分（`RULE.md` 与 `rule.md`）：macOS 和 Windows 的文件系统不区分大小写，两个规则会写成同一个文件，所以启动时直接报错。规则按码点排序，与系统 locale 无关。

## 安装策略

- 已有的规则文件永不覆盖，只报告跳过。
- 跳过的规则仍会执行它声明的步骤：这些步骤维护的是项目级约定（`.gitignore`、`AGENTS.md`），和规则文件本身无关。
- `gitignore` 自动执行；`agents` 会先问你。
- 一条规则失败不影响其他规则。
- 安装失败的规则不会被写进 `AGENTS.md`。
- 三处取消（选规则 / 步骤确认 / 最终确认）返回同一个结果，只会提示一次「已取消」。

顺带一提，`AGENTS.md` 里的引用块是**可自愈**的：重跑时保留之前引用过的规则，并把 0.1.x 写在根目录的旧链接（`./KEEPTIDY.md`）纠正成 `rules/KEEPTIDY.md`。

## 代码结构

一共 6 个文件，依赖是一条直线：

```text
bin/keeprules.js   argv → 意图、终端打印、退出码
src/flow.js        流程：选规则 → 问步骤 → 确认 → 安装 → 报告
src/install.js     写入策略：拷去哪、两个步骤怎么写、报什么
src/rules.js       规则发现：扫目录 + frontmatter
src/picker.js      选择器：文本宽度 + 状态机 + 终端适配
src/prompts.js     把 clack 和选择器的「取消/拒绝/作答」统一
```

依赖方向：`bin → flow → install`，`bin → prompts → picker`，`rules` 独立。无环。

## 常见改动

| 想改什么 | 改哪里 |
| --- | --- |
| 规则装到哪个目录 | `src/install.js` 的 `RULES_DIR`（唯一一处） |
| `AGENTS.md` 引用块的格式 | `src/install.js` 的 `renderBlock` / `renderSection` |
| 加一个步骤 | `src/install.js` 的 `STEPS` 加一项 + 写一个函数 |
| 打印样式 | `bin/keeprules.js` 的 `printer` |
| 选择器交互 | `src/picker.js` |

## 跨平台

支持 Linux、macOS 和 Windows：

- 路径一律用 `path.join` / `path.posix` 处理，写入 Markdown 的链接固定使用 `/`。
- 追加 `.gitignore` 与 `AGENTS.md` 时沿用文件原有的换行（CRLF/LF）与 BOM。
- 排序用码点比较，不依赖 locale 与 ICU 版本。
- 不依赖 shell，不使用 `chmod`、`/dev/*`、`os.tmpdir()` 等平台特定行为。

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

# 解除链接
npm unlink -g keeprules
```

### 打包测试

```bash
npm pack

mkdir demo && cd demo
npm init -y
npm install ../keeprules-1.0.0.tgz
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
