# 上架到 DSH 插件市场

市场里的条目来自精选列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，不是市场应用本身。上架 = **发布 npm 包 + GitHub 仓库 + 给精选列表提一个 YAML 文件**。

占位符已按 `x3416067-bit` 填好（`package.json` / `LICENSE` / `submission.yml`），无需再替换。

本机网络实测（2026-10-21）：`registry.npmjs.org`、`api.github.com`、`objects.githubusercontent.com` 可达；`github.com`、`codeload.github.com` 被重置或超时 —— 所以 **git push 与浏览器登录流程在本机不可用**，下面的脚本改走 GitHub REST API + npm token。

## 1. 发布 npm 包

包名 `dsh-plugin-restart-prompt` 在 npm 上未被占用（`npm view` 返回 404）。

```powershell
# token: npmjs.com → Access Tokens → Granular Access Token，勾 Read and write（Publish）
$env:NPM_TOKEN = 'npm_xxx'
node marketplace\publish-npm.mjs --dry-run   # 先彩排
node marketplace\publish-npm.mjs             # 正式发布
```

`npm login --auth-type=web` 在脚本化终端里会以 `Exit handler never called!` 结束（无 TTY），所以走 token。

## 2. 建 GitHub 仓库并推代码

仓库名 `dsh-plugin-restart-prompt`，**公开**；条目里的 `url` 必须与仓库地址完全一致。

```powershell
# token: github.com/settings/tokens → Classic 勾 repo；或 fine-grained 给 Contents + Pull requests 写权限
$env:GH_TOKEN = 'ghp_xxx'
node marketplace\publish-github.mjs
```

脚本做的事：`GET /user` 校验身份 → 建仓库（已存在则复用）→ 逐文件 `PUT /contents`（已存在则更新）→ 设置 `dsh-plugin`、`dsh` 等 topics。

本地 git 仓库已初始化并有首个提交（便携版 Git：`D:\DeepSeek\tools\git\cmd\git.exe`）；网络恢复后可 `git remote add origin …` 直接推。

收录硬性要求（CI 会校验）：

- `package.json` 有 `dsh.bundle`（本包已有）+ 同级 `cordis.patch.yml`（已有）。
- 仓库里有真实可运行的代码。
- 仓库创建**满 1 天**后才能提交；刚建的会被自动拒。
- 仓库带 `dsh-plugin` topic。
- 描述只说功能、不带营销词，且与代码一致。

## 3. 提 PR 到精选列表

```powershell
$env:GH_TOKEN = 'ghp_xxx'
node marketplace\publish-github.mjs --pr
```

脚本做的事：fork `awesome-dsh-plugin/awesome-dsh-plugin` → 等 fork 就绪 → 建分支 `add-dsh-plugin-restart-prompt` → 写入 `data/plugins/x3416067-bit__dsh-plugin-restart-prompt.yml`（内容取 `submission.yml`，去掉注释行）→ 开 PR。

PR 正文已写好：说明插件做什么、Windows-only、Node 20+，并注明两个 README 由 `scripts/generate-readme.mjs` 生成、不手工编辑。

**仓库未满 1 天时 PR 会 CI 失败** —— 属预期；次日重跑同一条命令即可（脚本对已存在的分支/文件做更新，不会冲突）。

## 4. 分类选择

填 `dev`。分类里没有单独的「插件管理」：`dev` 与 `market` 都说得通，`market` 偏向市场/插件管理类应用本身，本插件是「插件变动后重启」的开发期辅助。维护者若认为更合适会直接改，不会因此打回。

## 5. 上架后自查

- 市场搜索 `重启` / `restart` 能搜到卡片。
- 安装命令可执行：`dsh plugin --profile desktop add dsh-plugin-restart-prompt`。
- README 渲染正常（中英双段、表格、代码块）。
- `npm view dsh-plugin-restart-prompt version` 与仓库里的版本一致。
