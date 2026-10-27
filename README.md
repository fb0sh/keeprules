# keepit

交互式安装 Coding Agent 规则文件的 CLI 工具。

在项目根目录执行一条命令，即可通过多选界面把需要的规则文件复制到当前项目，并自动补齐 `.gitignore`、AGENTS.md 引用等基础设施配置。

## 快速开始

```bash
# 在目标项目根目录执行（两种写法行为相同）
npx keepit add
npx keepit
```

要求：Node.js >= 18，且需要在交互式终端中运行。

> `keepit` 这个 npm 包名目前已被其他维护者占用。若要从 npm 发布和安装，请使用 scope，例如 `@your-name/keepit`；本地开发和 `npm link` 不受影响。

## 它会做什么

1. 扫描 `rules/*.md`，读取 frontmatter 自动生成规则列表。
2. 显示规则选择界面：顶部是 `Select All (当前选中数/总数)`，默认不选中；`↑↓` 移动，空格切换，回车确认，高亮项的描述显示在列表下方。
3. 对支持 AGENTS.md 引用的规则，询问是否写入 AGENTS.md 引用区块。
4. 二次确认后，把选中的规则文件复制到**当前工作目录**。
5. 如果目标文件已存在，跳过且不覆盖，保留你的本地修改。
6. 对声明了 `postInstall: ['gitignore']` 的规则，检查 `.gitignore` 是否忽略 `/tmp/`；没有则追加，已有规则不受影响。
7. 安装过程显示 spinner，支持 `Esc` / `Ctrl+C` 取消。

安装过程不会访问网络，也不会读取或修改系统临时目录。

## 可用规则

| 规则 | 安装文件 | 说明 | postInstall |
| --- | --- | --- | --- |
| `KEEPTIDY` | `KEEPTIDY.md` | Coding Agent 工程卫生与资源管理规范（临时目录、Git 安全、进程清理、破坏性操作检查点等） | `gitignore`, `agents` |
| `KEEPSECURED` | `KEEPSECURED.md` | Coding Agent 安全与敏感信息保护规范（凭证、日志脱敏、禁止外传、生产环境约束） | `agents` |

`KEEPTIDY` 会确保项目 `.gitignore` 包含：

```gitignore
# keepit: 临时目录
/tmp/
```

## 规则自动注册

规则不再硬编码在代码中。CLI 启动时会扫描 `rules/` 下的所有 `.md` 文件，并解析文件顶部的 YAML frontmatter：

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

支持的字段：

- `id`：稳定标识，必须在所有规则中唯一
- `name`：选择界面中显示的名称
- `description`：高亮该规则时显示在列表下方的说明
- `postInstall`：可选安装步骤，当前支持 `gitignore` 和 `agents`

如果文件没有 frontmatter，会自动降级：

- `id` / `name` 使用文件名（不含 `.md`）
- `description` 使用正文第一行
- `postInstall` 为空

规则按文件名排序。若两个文件声明了相同的 `id`，CLI 会报错并提示冲突文件。

## AGENTS.md 引用（可选）

当选中的规则包含 `postInstall: ['agents']` 时，会额外询问：

> 是否在 AGENTS.md 中添加引用？

默认选择 Yes，也可以拒绝。同意后会以标记区块追加引用；如果同时选择多个规则，会合并到同一个区块：

```markdown
<!-- keepit:start -->
## KEEPSECURED

Follow the KEEPSECURED rules defined in [KEEPSECURED.md](./KEEPSECURED.md).

## KEEPTIDY

Follow the KEEPTIDY rules defined in [KEEPTIDY.md](./KEEPTIDY.md).

These rules are mandatory for all Coding Agents working in this repository.
<!-- keepit:end -->
```

写入规则：

- `AGENTS.md` 不存在：创建文件并写入区块。
- 已存在但没有 `<!-- keepit:start -->`：在文件末尾追加，并与原内容之间保留一个空行。
- 已存在标记区块：跳过，并提示「AGENTS.md 中已存在 keepit 引用」。
- 用户拒绝：跳过，不修改 `AGENTS.md`。

用户已有的 `AGENTS.md` 内容不会被覆盖。

## 命令行选项

```bash
keepit            # 进入交互式安装（默认不选中任何规则）
keepit add        # 同上
keepit --help     # 显示帮助
keepit --version  # 显示版本
```

多选快捷键：`↑↓` 移动光标，`空格` 切换选中 / Select All，`a` 快捷全选，`回车` 确认，`Esc` / `Ctrl+C` 取消。

规则选择界面参考 `vercel-labs/skills` 的交互风格：

```text
◆  选择要安装的规则
│
│ ❯ ○ Select All (0/2)
│   ────────────────────────────────────
│   ○ KEEPSECURED
│   ○ KEEPTIDY
│
│  Description
│  Coding Agent 安全与敏感信息保护规范（凭证、日志脱敏、
│  禁止外传、生产环境约束）
│
│  Selected: (none)
│
│  ↑↓ 移动 · 空格 选择 · 回车 确认
│  a 全选 / 取消全选 · Esc 取消
└
```

`Select All` 会显示 `○ 未选中` / `◐ 部分选中` / `● 全部选中` 三种状态。

## 项目结构

```text
keepit/
├── bin/
│   └── keepit.js                # CLI 入口（shebang + 安装流程）
├── src/
│   ├── rules.js                 # rules/*.md 扫描与 frontmatter 解析
│   └── prompts/
│       └── rule-multiselect.js  # 轻量自定义规则多选界面
├── rules/
│   ├── KEEPSECURED.md           # 随包发布的安全规则
│   └── KEEPTIDY.md              # 随包发布的工程卫生规则
├── test/
│   ├── keepit.test.js           # 安装逻辑与 CLI 行为测试
│   ├── rules.test.js            # 自动注册与 frontmatter 测试
│   └── rule-multiselect.test.js # 多选界面辅助逻辑测试
├── package.json
├── README.md
├── LICENSE
└── .gitignore
```

## 本地开发与测试

```bash
git clone <repo-url> keepit
cd keepit
npm install

npm test                        # 运行测试
node bin/keepit.js --help       # 直接运行 CLI
node bin/keepit.js --version
```

### 方式一：npm link（推荐调试 CLI）

```bash
# 在 keepit 仓库内
npm link

# 换到任意测试项目
cd /path/to/your-project
keepit add

# 不再需要时解除全局链接
npm unlink -g keepit
```

### 方式二：npm pack（模拟真实安装）

```bash
# 在 keepit 仓库内
npm pack
# 生成 keepit-0.1.0.tgz

# 在临时测试项目中安装
mkdir demo && cd demo
npm init -y
npm install ../keepit-0.1.0.tgz
npx keepit add
```

也可以先检查发布内容，确认只包含需要的文件：

```bash
npm pack --dry-run
```

## 发布到 npm

发布前确认登录状态正常，并跑通测试：

```bash
npm test
npm whoami                 # 未登录时先执行 npm login
npm view keepit version    # 注意：当前已被其他维护者占用
npm pack --dry-run         # 检查打包内容
npm publish --dry-run      # 发布预演
```

由于 `keepit` 已被占用，正式发布建议使用 scope：

```json
{
  "name": "@your-name/keepit"
}
```

```bash
npm publish --access public
npx @your-name/keepit add
```

若账号启用了两步验证，发布时按提示传入 `--otp=<code>`。

### 版本更新

```bash
npm version patch   # 0.1.0 -> 0.1.1（修复）
npm version minor   # 0.1.0 -> 0.2.0（新增规则/功能）
npm publish
```

## 添加新规则

1. 在 `rules/` 下新增 Markdown 文件，例如 `rules/MY_RULE.md`。
2. 在文件顶部添加 frontmatter（`id`、`name`、`description`、`postInstall`）。
3. 运行 `npm test` 和 `npm pack --dry-run`，确认新文件会被发布。

无需修改 `bin/keepit.js`，CLI 会自动发现并注册新规则。

## 设计约定

- 规则由 `rules/*.md` + frontmatter 自动注册，新增规则不需要改代码。
- 只复制，不覆盖：已有目标文件一律跳过，避免破坏用户内容。
- `.gitignore` 只追加缺失的 `/tmp/` 规则，保留全部现有内容。
- `AGENTS.md` 使用 `<!-- keepit:start -->` / `<!-- keepit:end -->` 标记区块，只追加一次，不覆盖原有内容。
- 规则选择界面为轻量自定义实现（readline + picocolors），包含 Select All、固定高度描述区和操作提示；交互风格参考 `vercel-labs/skills`，不依赖其代码。
- 交互取消（`Esc` / `Ctrl+C`）返回退出码 `0`，不会产生任何文件。
- 非 TTY 环境（如 CI）会直接报错退出，避免卡住。
- `AGENTS.md`、确认、预览等其余交互使用 `@clack/prompts` 0.11.x，以兼容 Node.js 18；更新的 1.x 要求 Node.js >= 20.12。

## License

MIT
