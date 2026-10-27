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
3. 复制选中的规则文件到当前项目。
4. 必要时补充 `.gitignore` 中的 `/tmp/` 规则。

已有的目标文件不会被覆盖。安装过程不访问网络。

### 快捷键

- `↑↓`：移动光标
- `空格`：选中 / 取消当前规则
- `a`：全选 / 取消全选
- `回车`：确认
- `Esc` / `Ctrl+C`：取消

`Select All` 会显示 `○ 未选中`、`◐ 部分选中`、`● 全部选中` 三种状态。

## 可用规则

| 规则 | 文件 | 说明 |
| --- | --- | --- |
| `KEEPTIDY` | `KEEPTIDY.md` | 工程卫生与资源管理（临时目录、Git 安全、进程清理、破坏性操作检查点） |
| `KEEPSECURED` | `KEEPSECURED.md` | 安全与敏感信息保护（凭证、日志脱敏、禁止外传、生产环境约束） |

选择 `KEEPTIDY` 时，会确保 `.gitignore` 包含：

```gitignore
# keeprules: 临时目录
/tmp/
```

所有规则都可以选择是否在 `AGENTS.md` 中添加引用。引用使用 `<!-- keeprules:start -->` / `<!-- keeprules:end -->` 区块，只追加，不覆盖已有内容。

## 命令行选项

```bash
keeprules            # 进入交互式安装
keeprules add        # 同上
keeprules --help     # 显示帮助
keeprules --version  # 显示版本
```

## 添加规则

在 `rules/` 下新增 Markdown 文件，并添加 frontmatter：

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

字段说明：

- `id`：唯一标识
- `name`：显示名称
- `description`：选择界面中的说明
- `postInstall`：可选步骤，目前支持 `gitignore` 和 `agents`

无需修改代码，CLI 会自动发现新规则。没有 frontmatter 时，`id` / `name` 使用文件名，`description` 使用正文第一行。

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
npm install ../keeprules-0.1.1.tgz
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
