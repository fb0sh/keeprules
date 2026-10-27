# keeptidy

交互式安装 Coding Agent 规则文件的 CLI 工具。

在项目根目录执行一条命令，即可通过多选界面把需要的规则文件复制到当前项目，并自动补齐 `.gitignore` 等基础设施配置。

## 快速开始

```bash
# 在目标项目根目录执行（两种写法行为相同）
npx keeptidy add
npx keeptidy
```

要求：Node.js >= 18，且需要在交互式终端中运行。

## 它会做什么

1. 显示可安装的规则列表（名称 + 描述），用空格多选、回车确认。
2. 对支持 AGENTS.md 引用的规则（目前是 KEEPTIDY），询问是否写入 AGENTS.md 引用区块。
3. 二次确认后，把选中的规则文件复制到**当前工作目录**。
4. 如果目标文件已存在，跳过且不覆盖，保留你的本地修改。
5. 对声明了 `postInstall: ['gitignore']` 的规则，检查 `.gitignore` 是否忽略 `/tmp/`；没有则追加，已有规则不受影响。
6. 安装过程显示 spinner，支持 `Esc` / `Ctrl+C` 取消。

安装过程不会访问网络，也不会读取或修改系统临时目录。

## 可用规则

| 规则 | 安装文件 | 说明 |
| --- | --- | --- |
| `KEEPTIDY` | `KEEPTIDY.md` | Coding Agent 工程卫生与资源管理规范（临时目录、Git 安全、进程清理、破坏性操作检查点等） |

`KEEPTIDY` 同时会确保项目 `.gitignore` 包含：

```gitignore
# keeptidy: 临时目录
/tmp/
```

### AGENTS.md 引用（可选）

安装 KEEPTIDY 时会额外询问：

> 是否在 AGENTS.md 中添加对 KEEPTIDY 的引用？

默认选择 Yes，也可以拒绝。同意后会以标记区块追加以下内容：

```markdown
<!-- keeptidy:start -->
## KEEPTIDY

Follow the engineering hygiene and resource management rules defined in [KEEPTIDY.md](./KEEPTIDY.md).

These rules are mandatory for all Coding Agents working in this repository.
<!-- keeptidy:end -->
```

写入规则：

- `AGENTS.md` 不存在：创建文件并写入区块。
- 已存在但没有 `<!-- keeptidy:start -->`：在文件末尾追加，并与原内容之间保留一个空行。
- 已存在标记区块：跳过，并提示「AGENTS.md 中已存在 KEEPTIDY 引用」。
- 用户拒绝：跳过，不修改 `AGENTS.md`。

用户已有的 `AGENTS.md` 内容不会被覆盖。

## 命令行选项

```bash
keeptidy            # 进入交互式安装
keeptidy add        # 同上
keeptidy --help     # 显示帮助
keeptidy --version  # 显示版本
```

## 项目结构

```text
keeptidy/
├── bin/
│   └── keeptidy.js       # CLI 入口（shebang + 交互流程）
├── rules/
│   └── KEEPTIDY.md       # 随包发布的规则文件
├── test/
│   └── keeptidy.test.js  # 安装逻辑与 CLI 行为测试
├── package.json
├── README.md
├── LICENSE
└── .gitignore
```

规则注册表 `RULES` 位于 `bin/keeptidy.js`，每项包含：

```js
{
  id: 'keeptidy',
  name: 'KEEPTIDY',
  description: '...',
  file: 'KEEPTIDY.md',
  postInstall: ['gitignore', 'agents'], // 可选
}
```

## 本地开发与测试

```bash
git clone <repo-url> keeptidy
cd keeptidy
npm install

npm test                          # 运行测试
node bin/keeptidy.js --help       # 直接运行 CLI
node bin/keeptidy.js --version
```

### 方式一：npm link（推荐调试 CLI）

```bash
# 在 keeptidy 仓库内
npm link

# 换到任意测试项目
cd /path/to/your-project
keeptidy add

# 不再需要时解除全局链接
npm unlink -g keeptidy
```

### 方式二：npm pack（模拟真实安装）

```bash
# 在 keeptidy 仓库内
npm pack
# 生成 keeptidy-0.1.0.tgz

# 在临时测试项目中安装
mkdir demo && cd demo
npm init -y
npm install ../keeptidy-0.1.0.tgz
npx keeptidy add
```

也可以先检查发布内容，确认只包含需要的文件：

```bash
npm pack --dry-run
```

## 发布到 npm

发布前确认包名可用、登录状态正常，并跑通测试：

```bash
npm test
npm whoami                 # 未登录时先执行 npm login
npm view keeptidy version  # 404 表示包名尚未被占用
npm pack --dry-run         # 检查打包内容
npm publish --dry-run      # 发布预演
```

正式发布：

```bash
npm publish
```

发布后验证：

```bash
npx keeptidy@latest --version
```

如果 `keeptidy` 已被他人占用，请改用 scope：

```json
{
  "name": "@your-name/keeptidy"
}
```

```bash
npm publish --access public
npx @your-name/keeptidy add
```

若账号启用了两步验证，发布时按提示传入 `--otp=<code>`。

### 版本更新

```bash
npm version patch   # 0.1.0 -> 0.1.1（修复）
npm version minor   # 0.1.0 -> 0.2.0（新增规则/功能）
npm publish
```

## 添加新规则

1. 在 `rules/` 下新增规则文件，例如 `rules/MY_RULE.md`。
2. 在 `bin/keeptidy.js` 的 `RULES` 数组中添加对应条目。
3. 如需额外配置，在 `postInstall` 中加入处理逻辑（当前支持 `gitignore` 和 `agents`）。
4. 运行 `npm test` 和 `npm pack --dry-run`，确认新文件会被发布。

## 设计约定

- 只复制，不覆盖：已有目标文件一律跳过，避免破坏用户内容。
- `.gitignore` 只追加缺失的 `/tmp/` 规则，保留全部现有内容。
- `AGENTS.md` 使用 `<!-- keeptidy:start -->` / `<!-- keeptidy:end -->` 标记区块，只追加一次，不覆盖原有内容。
- 交互取消（`Esc` / `Ctrl+C`）返回退出码 `0`，不会产生任何文件。
- 非 TTY 环境（如 CI）会直接报错退出，避免卡住。
- 使用 `@clack/prompts` 0.11.x，以兼容 Node.js 18；更新的 1.x 要求 Node.js >= 20.12。

## License

MIT
